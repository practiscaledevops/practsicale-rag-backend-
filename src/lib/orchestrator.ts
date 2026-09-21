// The Retrieval Orchestrator — how the Brain FINDS knowledge for a request.
//
//   UNDERSTAND the request (intent: work mode, job type, domains, entities,
//   lane weights, search queries)
//     → RETRIEVAL PLAN from the work mode's policy + the intent
//     → search each intelligence LANE in parallel (structured pre-filter in SQL
//       = "the right drawers", hybrid vector+keyword inside = "the right house")
//     → soft metadata BOOSTS (domain/type match, endorsement, authority,
//       currency, priority) — metadata narrows and boosts, never replaces meaning
//     → RELATIONSHIP EXPANSION (what is explicitly connected to what we found)
//     → RERANK (what matters most right now) with lane balance so the model gets
//       Reality + Learning + Playbooks, not 20 look-alike chunks
//     → labelled, lane-grouped CONTEXT (+ Performance Memory numbers)
//
// Graceful: falls back to the classic pipeline before migration 0017 or when
// the lane RPC is unavailable, and to a keyword heuristic when the intent
// classifier can't run. Used by /api/v1/chat (and /retrieve when enabled).

import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { embed } from "@/lib/embeddings";
import { hybridSearchLane, expandParents, LANE_RPC_MISSING, type LaneChunk, type RetrievedChunk } from "@/lib/retrieval";
import { rerank } from "@/lib/rerank";
import { rewriteQueries, type ChatTurn } from "@/lib/query-transform";
import { getActivePrompts } from "@/lib/prompts-db";
import { structured } from "@/lib/structured";
import { runRetrieval, type RetrievalOutput, type RetrievalStatus } from "@/lib/pipeline";
import { getObjectsByIds, listRelationshipsFor, listContradictionsAmong, type KnowledgeObjectRow } from "@/lib/knowledge-store";
import { fetchPerformanceBlock, type MetricRow } from "@/lib/performance-memory";
import {
  LANES,
  LANE_CLASS,
  LANE_LABEL,
  detectWorkModeHeuristic,
  resolveEffectiveMode,
  effectivePolicy,
  normalizeMode,
  modeDef,
  type WorkMode,
  type IntentKind,
  type Lane,
  type RetrievalPolicy,
} from "@/lib/work-modes";
import {
  authorityWeight,
  isCurrent,
  isDomain,
  FOUNDER_ENDORSEMENTS,
  INTERNAL_VALIDATIONS,
  PRIORITIES,
  DOMAINS,
} from "@/lib/intelligence-taxonomy";
import type { RagSettings } from "@/lib/settings";
import type { ScopeFilters } from "@/lib/auth/scope";

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

export interface Intent {
  workMode: WorkMode;
  intentKind: IntentKind;
  primaryDomain: string | null;
  relatedDomains: string[];
  problem: string;
  goal: string;
  keyConcepts: string[];
  entities: string[];
  needsNumbers: boolean;
  timeScope: "current" | "historical" | "any";
  lanes: Record<Lane, number>;
  searchQueries: string[];
  via: "llm" | "heuristic";
}

const IntentSchema = z.object({
  work_mode: z.string().default("general"),
  intent_kind: z.enum(["create", "advise", "build", "analyze", "lookup"]).default("advise"),
  primary_domain: z.string().nullable().optional(),
  related_domains: z.array(z.string()).default([]),
  problem: z.string().default(""),
  goal: z.string().default(""),
  key_concepts: z.array(z.string()).default([]),
  entities: z.array(z.string()).default([]),
  needs_numbers: z.boolean().default(false),
  time_scope: z.enum(["current", "historical", "any"]).default("any"),
  lanes: z
    .object({
      reality: z.number().min(0).max(1).default(1),
      learning: z.number().min(0).max(1).default(0.6),
      playbook: z.number().min(0).max(1).default(0.6),
      platform: z.number().min(0).max(1).default(0.2),
      performance: z.number().min(0).max(1).default(0.4),
    })
    .default({ reality: 1, learning: 0.6, playbook: 0.6, platform: 0.2, performance: 0.4 }),
  search_queries: z.array(z.string()).default([]),
});

const NUMBER_WORDS = /\b(rate|rates|how many|count|average|avg|trend|percent|%|score|scores|revenue|kpi|conversion|show[- ]?up|close|churn|numbers?)\b/i;

/** Heuristic intent when the classifier is unavailable. */
export function heuristicIntent(query: string): Intent {
  const mode = detectWorkModeHeuristic(query);
  const def = modeDef(mode)!;
  const q = query.toLowerCase();
  const domains = DOMAINS.filter((d) => q.includes(d.id.replace(/_/g, " ")) || q.includes(d.label.toLowerCase())).map((d) => d.id);
  const primary = domains[0] ?? def.policy.preferredDomains[0] ?? null;
  return {
    workMode: mode,
    intentKind: def.intent,
    primaryDomain: primary,
    relatedDomains: domains.slice(1, 3),
    problem: "",
    goal: "",
    keyConcepts: [],
    entities: [],
    needsNumbers: NUMBER_WORDS.test(query),
    timeScope: /\b(when we|back then|used to|last year|in 20\d\d|history|historical)\b/i.test(query) ? "historical" : /\b(now|current|currently|today|latest)\b/i.test(query) ? "current" : "any",
    lanes: { ...def.policy.lanes },
    searchQueries: [],
    via: "heuristic",
  };
}

export async function classifyIntent(opts: {
  query: string;
  history: ChatTurn[];
  systemPrompt: string;
  tier: string;
}): Promise<Intent> {
  const fallback = heuristicIntent(opts.query);
  const recent = opts.history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-4)
    .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
    .join("\n");
  const res = await structured({
    tier: opts.tier,
    system: opts.systemPrompt,
    prompt: `${recent ? `Recent conversation:\n${recent}\n\n` : ""}Latest request:\n${opts.query}`,
    schema: IntentSchema,
    maxTokens: 700,
  });
  if (!res) return fallback;
  const o = res.object;
  const mode = normalizeMode(o.work_mode) ?? fallback.workMode;
  const primary = o.primary_domain && isDomain(o.primary_domain) ? o.primary_domain : fallback.primaryDomain;
  return {
    workMode: mode === "auto" ? fallback.workMode : mode,
    intentKind: o.intent_kind,
    primaryDomain: primary,
    relatedDomains: (o.related_domains ?? []).filter((d) => isDomain(d) && d !== primary).slice(0, 3),
    problem: o.problem,
    goal: o.goal,
    keyConcepts: (o.key_concepts ?? []).slice(0, 8),
    entities: (o.entities ?? []).slice(0, 8),
    needsNumbers: o.needs_numbers || fallback.needsNumbers,
    timeScope: o.time_scope,
    lanes: o.lanes,
    searchQueries: (o.search_queries ?? []).map((s) => s.trim()).filter((s) => s.length > 1 && s.length <= 200).slice(0, 3),
    via: "llm",
  };
}

// ---------------------------------------------------------------------------
// Scoring (pure, exported for tests)
// ---------------------------------------------------------------------------

export interface ObjectMeta {
  ref: string;
  name: string;
  intelligence_class: string;
  domain: string;
  object_type: string;
  subtype: string | null;
  authority: string;
  founder_endorsement: string | null;
  internal_validation: string;
  priority: string;
  status: string;
  effective_from: string | null;
  effective_until: string | null;
  current: boolean;
}

export interface OrchestratedChunk extends LaneChunk {
  lane: Lane | "raw";
  object: ObjectMeta | null;
  /** Position-based relevance from the lane search (1 = best). */
  rank: number;
  boost: number;
  finalScore: number;
  via: "search" | "relationship";
  relatedTo?: string;
}

/**
 * Soft metadata boost for a candidate. Relevance comes from its rank in the
 * lane search; metadata only nudges: domain/type fit, endorsement, validation,
 * authority, currency (temporal validity vs the requested time scope), priority.
 */
export function scoreCandidate(args: {
  rank: number;
  laneWeight: number;
  lane: Lane | "raw";
  chunkDomain: string | null;
  object: ObjectMeta | null;
  policy: RetrievalPolicy;
  intent: Pick<Intent, "primaryDomain" | "relatedDomains" | "timeScope">;
  via: "search" | "relationship";
}): { boost: number; finalScore: number } {
  const base = (1 / (args.rank + 10)) * (0.5 + 0.5 * args.laneWeight); // ~0.09 for rank 1
  let boost = 0;
  const domain = args.object?.domain ?? args.chunkDomain;
  if (domain) {
    if (domain === args.intent.primaryDomain) boost += 0.03;
    else if (args.intent.relatedDomains.includes(domain)) boost += 0.015;
    if (args.policy.preferredDomains.includes(domain)) boost += 0.012;
  }
  const o = args.object;
  if (o) {
    if (args.policy.preferredTypes.includes(o.object_type)) boost += 0.01;
    boost += (FOUNDER_ENDORSEMENTS.find((e) => e.id === o.founder_endorsement)?.weight ?? 0) * 0.15;
    boost += (INTERNAL_VALIDATIONS.find((v) => v.id === o.internal_validation)?.weight ?? 0) * 0.15;
    boost += authorityWeight(o.authority) * 0.12;
    boost += (PRIORITIES.find((p) => p.id === o.priority)?.weight ?? 0) * 0.3;
    if (!o.current) boost += args.intent.timeScope === "historical" ? 0.01 : -0.03;
    else if (args.intent.timeScope === "historical") boost -= 0.005;
  }
  if (args.lane === "raw") boost -= 0.02;
  if (args.via === "relationship") boost -= 0.005;
  return { boost, finalScore: base + boost };
}

// ---------------------------------------------------------------------------
// Orchestrated retrieval
// ---------------------------------------------------------------------------

export interface LaneSummary {
  lane: Lane | "raw";
  label: string;
  weight: number;
  candidates: number;
  selected: number;
}

/** One side of a known disagreement (a `contradicts` edge inside the context). */
export type ConflictParty = { ref: string; name: string; authority: string };
export type ConflictPair = { a: ConflictParty; b: ConflictParty; note: string | null };

export interface OrchestrationOutput extends RetrievalOutput {
  intent: Intent;
  mode: WorkMode;
  auto: boolean;
  lanes: LaneSummary[];
  /** Lane-grouped, labelled context block (replaces buildContext for the prompt), + KNOWN DISAGREEMENTS when any. */
  contextBlock: string;
  /** Performance Memory table (may be ""). */
  performanceBlock: string;
  /** The metric rows behind `performanceBlock` (the numbers the answer used). */
  performanceMetrics: MetricRow[];
  /** Pairs of objects in context that contradict each other (higher authority first). */
  conflicts: ConflictPair[];
  /** Refs of the knowledge objects in context (for the client + learning capture). */
  objects: { ref: string; name: string; lane: string }[];
  /** Per-chunk lane/object info aligned with `chunks` (for the sources event). */
  annotated: OrchestratedChunk[];
  /** true when the classic pipeline was used (pre-migration / RPC missing). */
  fallback: boolean;
}

export interface OrchestrateOptions {
  orgId: string;
  query: string;
  history?: ChatTurn[];
  scope: ScopeFilters;
  settings: RagSettings;
  /** The caller's mode (canonical id, alias, "auto", or undefined = auto). */
  requestedMode?: string | null;
  /** Modes the caller's user may use; Auto never resolves outside this list (restricted modes stay gated). */
  allowedModes?: string[] | null;
  onStatus?: (s: RetrievalStatus & { mode?: string; lanes?: string[] }) => void;
}

function objectMeta(o: KnowledgeObjectRow): ObjectMeta {
  return {
    ref: o.ref,
    name: o.name,
    intelligence_class: o.intelligence_class,
    domain: o.domain,
    object_type: o.object_type,
    subtype: o.subtype,
    authority: o.authority,
    founder_endorsement: o.founder_endorsement,
    internal_validation: o.internal_validation,
    priority: o.priority,
    status: o.status,
    effective_from: o.effective_from,
    effective_until: o.effective_until,
    current: isCurrent(o),
  };
}

function laneOfClass(cls: string): Lane | "raw" {
  for (const l of LANES) if (LANE_CLASS[l].includes(cls as never)) return l;
  return cls === "raw_archive" ? "raw" : "reality";
}

/** Round-robin merge that guarantees each lane keeps its best few before the pool fills. */
function balancedPool(byLane: Map<Lane | "raw", OrchestratedChunk[]>, limit: number, minPerLane: number): OrchestratedChunk[] {
  const out: OrchestratedChunk[] = [];
  const seen = new Set<string>();
  const lanes = Array.from(byLane.keys());
  // 1) Reserve the top-N of every lane.
  for (const l of lanes) {
    for (const c of (byLane.get(l) ?? []).slice(0, minPerLane)) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        out.push(c);
      }
    }
  }
  // 2) Fill the rest by global finalScore.
  const rest = lanes
    .flatMap((l) => byLane.get(l) ?? [])
    .filter((c) => !seen.has(c.id))
    .sort((a, b) => b.finalScore - a.finalScore);
  for (const c of rest) {
    if (out.length >= limit) break;
    seen.add(c.id);
    out.push(c);
  }
  return out.slice(0, limit);
}

export async function runOrchestratedRetrieval(opts: OrchestrateOptions): Promise<OrchestrationOutput> {
  const { orgId, query, scope, settings } = opts;
  const history = opts.history ?? [];
  const emit = opts.onStatus ?? (() => {});
  const db = supabaseAdmin();
  const { features, retrieval, intelligence } = settings;

  // 1. Understand the request.
  const prompts = await getActivePrompts(orgId, ["intent_classify", "query_rewrite"]);
  emit({ stage: "planning", label: "Understanding the request" });
  const intent =
    features.autoWorkMode || !normalizeMode(opts.requestedMode)
      ? await classifyIntent({ query, history, systemPrompt: prompts.intent_classify, tier: intelligence.intentTier })
      : heuristicIntent(query);
  let { mode, auto } = resolveEffectiveMode(opts.requestedMode, intent.workMode);
  if (opts.allowedModes && opts.allowedModes.length) {
    const allowed = new Set(opts.allowedModes.map((m) => normalizeMode(m)).filter((m): m is WorkMode => !!m));
    if (!allowed.has(mode)) {
      mode = allowed.has("general") ? "general" : (Array.from(allowed).find((m) => m !== "auto") ?? "general");
      auto = true;
    }
  }
  const def = modeDef(mode)!;
  const policy = effectivePolicy(mode, [intent.primaryDomain, ...intent.relatedDomains].filter((d): d is string => !!d));
  emit({ stage: "planning", label: auto ? `Auto → ${def.label}` : `${def.label} mode`, mode });

  // 2. Search queries: intent's (already discriminative) or the rewrite stage.
  let queries = intent.searchQueries.length ? intent.searchQueries : [query];
  const priorTurns = history.filter((m) => m.role === "user" || m.role === "assistant").length;
  if (!intent.searchQueries.length && features.queryRewrite && (priorTurns > 1 || query.trim().split(/\s+/).length > 6)) {
    emit({ stage: "rewriting", label: "Refining the question" });
    queries = await rewriteQueries(query, history, prompts.query_rewrite, "fast");
  }
  const rewritten = queries.length > 1 || queries[0] !== query;

  // 3. Lane plan: policy weight × intent weight (either can silence a lane).
  const laneWeights: Record<Lane, number> = { reality: 0, learning: 0, playbook: 0, platform: 0, performance: 0 };
  for (const l of LANES) laneWeights[l] = Math.max(0, Math.min(1, Math.sqrt(policy.lanes[l] * (intent.lanes[l] ?? 0.5))));
  // Reality is never silenced entirely (it is the evidence).
  laneWeights.reality = Math.max(laneWeights.reality, 0.5);
  const active = LANES.filter((l) => l !== "performance" && laneWeights[l] >= 0.15);
  const includeRaw = !!policy.includeRaw && intent.intentKind === "analyze";
  emit({ stage: "searching", label: `Searching ${active.map((l) => LANE_LABEL[l]).join(" · ")}`, lanes: active });

  // 4. Parallel lane searches (one embedding per query, shared across lanes).
  const perLane = Math.max(10, Math.min(120, intelligence.laneCandidates));
  let laneResults: { lane: Lane | "raw"; chunks: LaneChunk[] }[];
  try {
    const embeddings = await Promise.all(queries.map((q) => embed(q)));
    const jobs: Promise<{ lane: Lane | "raw"; chunks: LaneChunk[] }>[] = [];
    const searchLane = async (lane: Lane | "raw", classes: string[]) => {
      const lists = await Promise.all(
        queries.map((q, i) =>
          hybridSearchLane({
            orgId,
            query: q,
            scope,
            classes,
            matchCount: Math.ceil(perLane * (lane === "reality" ? 1 : 0.75)),
            fullTextWeight: retrieval.fullTextWeight,
            semanticWeight: retrieval.semanticWeight,
            rrfK: retrieval.rrfK,
            queryEmbedding: embeddings[i],
          })
        )
      );
      return { lane, chunks: interleave(lists, perLane) };
    };
    for (const l of active) jobs.push(searchLane(l, LANE_CLASS[l]));
    if (includeRaw) jobs.push(searchLane("raw", ["raw_archive"]));
    laneResults = await Promise.all(jobs);
  } catch (e) {
    if (e instanceof Error && e.message === LANE_RPC_MISSING) {
      // Pre-migration: classic pipeline, same output shape.
      const legacy = await runRetrieval({ orgId, query, history, scope, settings, onStatus: opts.onStatus });
      return wrapLegacy(legacy, intent, mode, auto);
    }
    throw e;
  }

  // 5. Object metadata for boosting + labelling (one query).
  const objectIds = Array.from(new Set(laneResults.flatMap((r) => r.chunks.map((c) => c.object_id)).filter((x): x is string => !!x)));
  const objects = await getObjectsByIds(db, orgId, objectIds);

  const annotate = (c: LaneChunk, lane: Lane | "raw", rank: number, via: "search" | "relationship", relatedTo?: string): OrchestratedChunk => {
    const o = c.object_id ? objects.get(c.object_id) : undefined;
    const meta = o ? objectMeta(o) : null;
    const { boost, finalScore } = scoreCandidate({
      rank,
      laneWeight: lane === "raw" ? 0.3 : laneWeights[lane],
      lane,
      chunkDomain: c.domain,
      object: meta,
      policy,
      intent,
      via,
    });
    return { ...c, lane, object: meta, rank, boost, finalScore, via, relatedTo };
  };

  const byLane = new Map<Lane | "raw", OrchestratedChunk[]>();
  for (const r of laneResults) {
    const list = r.chunks
      // Expired / historical objects are dropped for "current" asks unless nothing else exists.
      .map((c, i) => annotate(c, r.lane, i + 1, "search"))
      .filter((c) => !(intent.timeScope === "current" && c.object && !c.object.current && c.object.status !== "active"));
    byLane.set(r.lane, list.sort((a, b) => b.finalScore - a.finalScore));
  }

  // 6. Relationship expansion (1 hop from the strongest objects).
  let expandedCount = 0;
  if (features.relationshipExpansion && objects.size > 0) {
    const topObjectIds = Array.from(byLane.values())
      .flat()
      .sort((a, b) => b.finalScore - a.finalScore)
      .map((c) => c.object_id)
      .filter((x): x is string => !!x)
      .filter((x, i, arr) => arr.indexOf(x) === i)
      .slice(0, 6);
    const edges = await listRelationshipsFor(db, orgId, topObjectIds, "confirmed");
    const related = new Map<string, string>(); // relatedObjectId → via ref
    for (const e of edges) {
      const [from, to] = topObjectIds.includes(e.source_object_id) ? [e.source_object_id, e.target_object_id] : [e.target_object_id, e.source_object_id];
      if (!topObjectIds.includes(to) && !objects.has(to)) related.set(to, objects.get(from)?.ref ?? from);
      else if (!topObjectIds.includes(to)) related.set(to, objects.get(from)?.ref ?? from);
    }
    const relatedIds = Array.from(related.keys()).slice(0, 8);
    if (relatedIds.length) {
      emit({ stage: "expanding", label: "Following connected knowledge" });
      try {
        const more = await hybridSearchLane({ orgId, query: queries[0], scope, objectIds: relatedIds, matchCount: 12, fullTextWeight: retrieval.fullTextWeight, semanticWeight: retrieval.semanticWeight, rrfK: retrieval.rrfK });
        const extraObjects = await getObjectsByIds(db, orgId, relatedIds);
        for (const [k, v] of extraObjects) objects.set(k, v);
        const seen = new Set(Array.from(byLane.values()).flat().map((c) => c.id));
        more.forEach((c, i) => {
          if (seen.has(c.id)) return;
          const lane = laneOfClass(c.intelligence_class);
          const ann = annotate(c, lane, i + 3, "relationship", related.get(c.object_id ?? "") ?? undefined);
          byLane.set(lane, [...(byLane.get(lane) ?? []), ann].sort((a, b) => b.finalScore - a.finalScore));
          expandedCount++;
        });
      } catch {
        /* expansion is optional */
      }
    }
  }

  // 7. Lane-balanced candidate pool → rerank → lane-balanced final selection.
  const pool = balancedPool(byLane, retrieval.matchCount, 3);
  let top: OrchestratedChunk[];
  if (features.rerank && pool.length > retrieval.rerankTopN) {
    emit({ stage: "reranking", label: "Ranking the best evidence" });
    // Rerank only a lane-balanced, score-sorted WINDOW rather than the whole
    // pool: the LLM reranker's prompt (and latency, which is paid before the
    // first token) grows with the candidate count, and our finalScore already
    // pre-orders the pool, so the true top-N almost always lives in the window.
    const rerankInput = pool.slice(0, Math.max(retrieval.rerankTopN * 3, 24));
    const ranked = await rerank(query, rerankInput, retrieval.rerankTopN);
    const byId = new Map(pool.map((c) => [c.id, c]));
    top = ranked.map((r) => ({ ...(byId.get(r.id) ?? (r as OrchestratedChunk)), score: r.score }));
  } else {
    top = pool.sort((a, b) => b.finalScore - a.finalScore).slice(0, retrieval.rerankTopN);
  }
  // Guarantee each strongly-weighted lane with candidates keeps a seat.
  for (const l of active) {
    if (laneWeights[l] < 0.6) continue;
    const cands = byLane.get(l) ?? [];
    if (!cands.length || top.some((c) => c.lane === l)) continue;
    const best = cands[0];
    const dominant = top.map((c, i) => ({ c, i })).filter((x) => x.c.lane !== l).sort((a, b) => a.c.finalScore - b.c.finalScore)[0];
    if (dominant) top[dominant.i] = best;
    else top.push(best);
  }

  const confidence = confidenceFrom(top);

  // 8. Parent expansion for fuller context (keeps the annotation).
  let final = top;
  if (retrieval.expandParents && top.some((c) => c.parent_id)) {
    emit({ stage: "expanding", label: "Gathering full context" });
    const parents = await expandParents(top);
    final = top.map((c, i) => ({ ...c, id: parents[i].id, content: parents[i].content, metadata: parents[i].metadata, parent_id: parents[i].parent_id }));
  }

  // 9. Known disagreements: `contradicts` edges with BOTH ends in context (the
  //    compiler confirms one on a CONFLICT verdict; reviewers confirm others).
  //    The model is told which side carries more authority and that the other
  //    exists, instead of silently picking one.
  const contextObjectIds = Array.from(new Set(final.map((c) => c.object_id).filter((x): x is string => !!x)));
  // 10. Performance Memory (numbers) when the request wants them or the mode leans on it.
  //     Both reads are independent, so they share one round trip on the critical path.
  const wantsPerformance = laneWeights.performance >= 0.3 || intent.needsNumbers;
  const [contradictions, perf] = await Promise.all([
    contextObjectIds.length > 1 ? listContradictionsAmong(db, orgId, contextObjectIds) : Promise.resolve([]),
    wantsPerformance
      ? fetchPerformanceBlock(db, orgId, { query, keyConcepts: intent.keyConcepts, entities: intent.entities, needsNumbers: intent.needsNumbers })
      : Promise.resolve(null),
  ]);
  const conflicts = contradictions.length ? pairConflicts(contradictions, objects) : [];
  const performanceBlock = perf?.block ?? "";
  const performanceMetrics: MetricRow[] = perf?.metrics ?? [];

  const lanes: LaneSummary[] = [...active, ...(includeRaw ? (["raw"] as const) : [])].map((l) => ({
    lane: l,
    label: l === "raw" ? "Raw Archive" : LANE_LABEL[l],
    weight: l === "raw" ? 0.3 : laneWeights[l],
    candidates: byLane.get(l)?.length ?? 0,
    selected: final.filter((c) => c.lane === l).length,
  }));
  if (laneWeights.performance >= 0.3 || intent.needsNumbers) {
    lanes.push({ lane: "performance", label: LANE_LABEL.performance, weight: laneWeights.performance, candidates: performanceBlock ? 1 : 0, selected: performanceBlock ? 1 : 0 });
  }

  const objectsInContext = Array.from(new Map(final.filter((c) => c.object).map((c) => [c.object!.ref, { ref: c.object!.ref, name: c.object!.name, lane: c.lane }])).values());

  emit({ stage: "retrieved", label: `Retrieved ${final.length} source${final.length === 1 ? "" : "s"}${expandedCount ? ` (+${expandedCount} connected)` : ""}`, count: final.length });

  const disagreements = buildDisagreementsBlock(conflicts);
  return {
    chunks: final,
    effectiveQuery: queries.join(" | "),
    rewritten,
    sourceTypes: scope.sourceTypes,
    confidence,
    intent,
    mode,
    auto,
    lanes,
    contextBlock: disagreements ? `${buildLaneContext(final)}\n\n\n${disagreements}` : buildLaneContext(final),
    performanceBlock,
    performanceMetrics,
    conflicts,
    objects: objectsInContext,
    annotated: final,
    fallback: false,
  };
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

const LANE_ORDER: (Lane | "raw")[] = ["reality", "learning", "playbook", "platform", "performance", "raw"];
const LANE_HEADER: Record<Lane | "raw", string> = {
  reality: "BUSINESS REALITY — what is true / what happened (your evidence)",
  learning: "ORGANIZATIONAL LEARNING — what PractiScale tried, what happened, what we learned",
  playbook: "PLAYBOOKS — frameworks we believe in (present as frameworks, not proven facts)",
  platform: "PLATFORM INTELLIGENCE — how each platform works",
  performance: "PERFORMANCE MEMORY — structured results",
  raw: "RAW ARCHIVE — unprocessed source material (low authority)",
};

function chunkHeader(c: OrchestratedChunk): string {
  const o = c.object;
  if (o) {
    const cur = o.status === "historical" ? "HISTORICAL" : o.status === "archived" ? "ARCHIVED" : o.current ? "current" : "EXPIRED";
    const bits = [
      `${o.ref} · ${o.name}`,
      [o.intelligence_class, o.domain, o.object_type, o.subtype].filter(Boolean).join("/"),
      `authority ${o.authority}`,
      o.founder_endorsement ? `endorsement ${o.founder_endorsement}` : "",
      o.internal_validation !== "unvalidated" ? `validation ${o.internal_validation}` : "",
      cur,
      c.relatedTo ? `connected via ${c.relatedTo}` : "",
    ].filter(Boolean);
    return `⟨${bits.join(" · ")}⟩`;
  }
  const md = (c.metadata ?? {}) as Record<string, unknown>;
  const bits = [
    "business reality",
    typeof c.source_type === "string" ? c.source_type.replace(/_/g, " ") : "",
    typeof md.title === "string" ? md.title : typeof md.filename === "string" ? md.filename : "",
    typeof md.category === "string" ? md.category : "",
  ].filter(Boolean);
  return `⟨${bits.join(" · ")}⟩`;
}

/** Lane-grouped context: every chunk keeps its [id] for citations plus an identity header. */
export function buildLaneContext(chunks: OrchestratedChunk[]): string {
  const groups = new Map<Lane | "raw", OrchestratedChunk[]>();
  for (const c of chunks) groups.set(c.lane, [...(groups.get(c.lane) ?? []), c]);
  const parts: string[] = [];
  for (const lane of LANE_ORDER) {
    const list = groups.get(lane);
    if (!list || !list.length) continue;
    parts.push(`### ${LANE_HEADER[lane]}\n\n${list.map((c) => `[${c.id}] ${chunkHeader(c)}\n${c.content}`).join("\n\n---\n\n")}`);
  }
  return parts.join("\n\n\n");
}

/**
 * De-duplicated contradiction pairs among the objects in context (the compiler
 * writes `contradicts` both ways). Edges with an end outside `objects` are
 * dropped; the higher-authority side comes first.
 */
export function pairConflicts(
  edges: { source_object_id: string; target_object_id: string; note: string | null }[],
  objects: Map<string, Pick<ObjectMeta, "ref" | "name" | "authority">>
): ConflictPair[] {
  const seen = new Set<string>();
  const out: ConflictPair[] = [];
  for (const e of edges) {
    const s = objects.get(e.source_object_id);
    const t = objects.get(e.target_object_id);
    if (!s || !t || e.source_object_id === e.target_object_id) continue;
    const key = [e.source_object_id, e.target_object_id].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    const party = (o: Pick<ObjectMeta, "ref" | "name" | "authority">): ConflictParty => ({ ref: o.ref, name: o.name, authority: o.authority });
    const sFirst = authorityWeight(s.authority) > authorityWeight(t.authority) || (authorityWeight(s.authority) === authorityWeight(t.authority) && s.ref <= t.ref);
    const note = e.note ? e.note.replace(/\s+/g, " ").trim().slice(0, 300) : "";
    out.push({ a: party(sFirst ? s : t), b: party(sFirst ? t : s), note: note || null });
  }
  return out;
}

/** The KNOWN DISAGREEMENTS block appended after the lane-grouped context ("" when none). */
export function buildDisagreementsBlock(pairs: ConflictPair[]): string {
  if (!pairs.length) return "";
  const lines = pairs.map((p) => {
    const note = p.note ? p.note.replace(/[.;:,\s]+$/, "") : "";
    return `- [${p.a.ref}] "${p.a.name}" (authority ${p.a.authority}) disagrees with [${p.b.ref}] "${p.b.name}" (authority ${p.b.authority})${note ? ` — ${note}` : ""}. Reason with the higher-authority, more current source and say that the other exists.`;
  });
  return `### KNOWN DISAGREEMENTS — sources above that contradict each other\n\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function interleave(lists: LaneChunk[][], limit: number): LaneChunk[] {
  const seen = new Set<string>();
  const out: LaneChunk[] = [];
  const maxLen = lists.reduce((m, l) => Math.max(m, l.length), 0);
  for (let i = 0; i < maxLen && out.length < limit; i++) {
    for (const list of lists) {
      const c = list[i];
      if (c && !seen.has(c.id)) {
        seen.add(c.id);
        out.push(c);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

function confidenceFrom(chunks: RetrievedChunk[]): number | null {
  const scores = chunks.map((c) => c.score).filter((s): s is number => typeof s === "number");
  if (!scores.length) return null;
  const top = scores.slice(0, 3);
  return Math.max(0, Math.min(1, top.reduce((a, b) => a + b, 0) / top.length));
}

function wrapLegacy(legacy: RetrievalOutput, intent: Intent, mode: WorkMode, auto: boolean): OrchestrationOutput {
  const annotated: OrchestratedChunk[] = legacy.chunks.map((c, i) => ({
    ...c,
    object_id: null,
    intelligence_class: "business_reality",
    domain: null,
    rrf_score: 0,
    lane: "reality",
    object: null,
    rank: i + 1,
    boost: 0,
    finalScore: 1 / (i + 10),
    via: "search",
  }));
  return {
    ...legacy,
    intent,
    mode,
    auto,
    lanes: [{ lane: "reality", label: LANE_LABEL.reality, weight: 1, candidates: legacy.chunks.length, selected: legacy.chunks.length }],
    contextBlock: buildLaneContext(annotated),
    performanceBlock: "",
    performanceMetrics: [],
    conflicts: [],
    objects: [],
    annotated,
    fallback: true,
  };
}
