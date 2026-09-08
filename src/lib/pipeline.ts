// The unified retrieval pipeline. ONE place that ties together every retrieval
// stage, driven by the org's RagSettings and its editable prompts:
//
//   query rewrite (optional) → route (keyword|LLM, optional) → hybrid search
//   → rerank (optional) → parent expansion (optional)
//
// Every stage is graceful (see the individual libs), so a provider outage or a
// disabled feature degrades quality without breaking retrieval. Used by
// /api/v1/chat, /api/v1/retrieve, and the admin playground so all three behave
// identically and honour the same dashboard settings.

import { hybridSearchScoped, expandParents, type RetrievedChunk } from "@/lib/retrieval";
import { rerank } from "@/lib/rerank";
import { rewriteQuery, type ChatTurn } from "@/lib/query-transform";
import { routeQueryLLM } from "@/lib/router";
import { getActivePrompts } from "@/lib/prompts-db";
import type { RagSettings } from "@/lib/settings";
import type { ScopeFilters } from "@/lib/auth/scope";

export interface RetrievalOutput {
  chunks: RetrievedChunk[];
  /** The query actually used for retrieval (after rewrite). */
  effectiveQuery: string;
  /** Whether the query was rewritten from the original. */
  rewritten: boolean;
  /** Source types retrieval was narrowed to ([] = all in scope). */
  sourceTypes: string[];
}

/** A real-time pipeline stage, surfaced to the UI as an activity indicator. */
export interface RetrievalStatus {
  stage: "planning" | "rewriting" | "routing" | "searching" | "reranking" | "expanding" | "retrieved";
  label: string;
  count?: number;
}

/**
 * Run the full retrieval pipeline within a key/admin scope.
 * `history` is used only for query rewriting (reference resolution).
 * `onStatus` (optional) receives each stage as it happens, for a live UI.
 */
export async function runRetrieval(opts: {
  orgId: string;
  query: string;
  history?: ChatTurn[];
  scope: ScopeFilters;
  settings: RagSettings;
  onStatus?: (s: RetrievalStatus) => void;
}): Promise<RetrievalOutput> {
  const { orgId, query, scope, settings } = opts;
  const history = opts.history ?? [];
  const emit = opts.onStatus ?? (() => {});
  const { features, retrieval } = settings;

  // Query rewrite earns its keep in two cases:
  //   1. follow-ups — resolve "it"/"that" against prior turns, AND
  //   2. long/conversational first questions — distil "write a story on our
  //      consultant James Anderson how he is doing" down to the key search terms,
  //      so keyword retrieval isn't drowned by common words. Short, direct first
  //      questions skip it (they retrieve fine and stay fast).
  const priorTurns = history.filter((m) => m.role === "user" || m.role === "assistant").length;
  const wordCount = query.trim().split(/\s+/).filter(Boolean).length;
  const willRewrite = features.queryRewrite && (priorTurns > 1 || wordCount > 6);

  // Load only the prompts the enabled stages need (one query).
  const needed: string[] = [];
  if (willRewrite) needed.push("query_rewrite");
  if (features.llmRouter) needed.push("router");
  const prompts = needed.length ? await getActivePrompts(orgId, needed) : {};

  // 1. Query rewrite (recall ↑), follow-ups only.
  let effectiveQuery = query;
  if (willRewrite) {
    emit({ stage: "rewriting", label: "Refining the question" });
    effectiveQuery = await rewriteQuery(query, history, prompts.query_rewrite, "fast");
  }
  const rewritten = effectiveQuery !== query;

  // 2. Route → narrow source types WITHIN the key's allowed set (never widen).
  let sourceTypes = scope.sourceTypes;
  if (features.llmRouter) {
    emit({ stage: "routing", label: "Choosing sources" });
    const picked = await routeQueryLLM(effectiveQuery, prompts.router, "fast");
    if (picked.length > 0) {
      const allowed = scope.sourceTypes;
      const narrowed = allowed.length > 0 ? picked.filter((p) => allowed.includes(p)) : picked;
      // Never over-narrow to nothing — fall back to the full allowed set.
      sourceTypes = narrowed.length > 0 ? narrowed : allowed;
    }
  }

  // 3. Hybrid search (scope-enforced in SQL) with configured RRF weights.
  emit({ stage: "searching", label: "Searching the knowledge base" });
  const candidates = await hybridSearchScoped({
    orgId,
    query: effectiveQuery,
    scope,
    sourceTypes,
    matchCount: retrieval.matchCount,
    fullTextWeight: retrieval.fullTextWeight,
    semanticWeight: retrieval.semanticWeight,
    rrfK: retrieval.rrfK,
  });

  // 4. Rerank (or just take the top-N).
  let top: RetrievedChunk[];
  if (features.rerank && candidates.length > retrieval.rerankTopN) {
    emit({ stage: "reranking", label: "Ranking the best matches" });
    top = await rerank(effectiveQuery, candidates, retrieval.rerankTopN);
  } else {
    top = candidates.slice(0, retrieval.rerankTopN);
  }

  // 5. Parent expansion (fuller context for grounding).
  let chunks = top;
  if (retrieval.expandParents && top.some((c) => c.parent_id)) {
    emit({ stage: "expanding", label: "Gathering full context" });
    chunks = await expandParents(top);
  }

  emit({ stage: "retrieved", label: `Retrieved ${chunks.length} source${chunks.length === 1 ? "" : "s"}`, count: chunks.length });
  return { chunks, effectiveQuery, rewritten, sourceTypes };
}
