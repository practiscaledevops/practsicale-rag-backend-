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

/**
 * Run the full retrieval pipeline within a key/admin scope.
 * `history` is used only for query rewriting (reference resolution).
 */
export async function runRetrieval(opts: {
  orgId: string;
  query: string;
  history?: ChatTurn[];
  scope: ScopeFilters;
  settings: RagSettings;
}): Promise<RetrievalOutput> {
  const { orgId, query, scope, settings } = opts;
  const history = opts.history ?? [];
  const { features, retrieval } = settings;

  // Load only the prompts the enabled stages need (one query).
  const needed: string[] = [];
  if (features.queryRewrite) needed.push("query_rewrite");
  if (features.llmRouter) needed.push("router");
  const prompts = needed.length ? await getActivePrompts(orgId, needed) : {};

  // 1. Query rewrite (recall ↑).
  let effectiveQuery = query;
  if (features.queryRewrite) {
    effectiveQuery = await rewriteQuery(query, history, prompts.query_rewrite, "fast");
  }
  const rewritten = effectiveQuery !== query;

  // 2. Route → narrow source types WITHIN the key's allowed set (never widen).
  let sourceTypes = scope.sourceTypes;
  if (features.llmRouter) {
    const picked = await routeQueryLLM(effectiveQuery, prompts.router, "fast");
    if (picked.length > 0) {
      const allowed = scope.sourceTypes;
      const narrowed = allowed.length > 0 ? picked.filter((p) => allowed.includes(p)) : picked;
      // Never over-narrow to nothing — fall back to the full allowed set.
      sourceTypes = narrowed.length > 0 ? narrowed : allowed;
    }
  }

  // 3. Hybrid search (scope-enforced in SQL) with configured RRF weights.
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
  const top = features.rerank
    ? await rerank(effectiveQuery, candidates, retrieval.rerankTopN)
    : candidates.slice(0, retrieval.rerankTopN);

  // 5. Parent expansion (fuller context for grounding).
  const chunks = retrieval.expandParents ? await expandParents(top) : top;

  return { chunks, effectiveQuery, rewritten, sourceTypes };
}
