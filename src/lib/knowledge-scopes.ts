// Knowledge scopes — the "Search in" choices a consumer app offers next to its
// composer (Auto · All Brain · Reality · Playbooks · Learnings · Consultant
// calls). ONE catalogue, here: the chat API validates `knowledgeScope` against
// it, GET /api/v1/collections advertises it (so a scope added here appears in
// every spoke without a change on their side), and the orchestrator plans its
// lane search from it (planLaneWeights).
//
// A scope can only NARROW retrieval: it picks which intelligence lanes are
// searched and may restrict source types, always intersected with the key's
// scope (never widened). Pure data + helpers — safe for client and server.

import { LANES, type IntentKind, type Lane, type RetrievalPolicy } from "./work-modes";

export type KnowledgeScopeId = "auto" | "all" | "reality" | "playbook" | "learning" | "calls";

/** The lanes a fixed scope can search (performance is a block, not a search). */
type SearchLane = Exclude<Lane, "performance">;

export interface KnowledgeScopeRetrieval {
  /**
   * Fixed lane weights, or null for the per-question plan (work-mode policy ×
   * intent, reality floor). Lanes left out are not searched.
   */
  lanes: Partial<Record<SearchLane, number>> | null;
  /** Raw archive lane (weight 0.3): the per-question rule, always, or never. */
  raw: "auto" | "always" | "never";
  /**
   * Performance Memory block: the per-question rule (lane weight ≥ 0.3 or the
   * question needs numbers), only when the question needs numbers, or never.
   */
  performance: "auto" | "numbers" | "never";
  /**
   * Structured call-review path (every matching call, in full):
   *   gated  = runs when the question reads as a call review (today's behaviour)
   *   forced = the cheap review probe is skipped; the roster-aware resolve decides
   *   off    = never
   * Always subject to the key scope permitting transcripts.
   */
  callReview: "gated" | "forced" | "off";
  /** Restrict retrieval to these source types (intersected with the key scope; never widens). */
  sourceTypes?: readonly string[];
}

export interface KnowledgeScopeDef {
  id: KnowledgeScopeId;
  label: string;
  /** One line, written for the person choosing where to search. */
  description: string;
  /** Raw call material — only offered to keys (and users) that may reach it. */
  sensitive: boolean;
  retrieval: KnowledgeScopeRetrieval;
  /** The answer when none of the scope's source types is reachable for the caller. */
  unavailableNote?: string;
}

/** The call data: AI call-scoring results + QA transcripts (documents.source_type ids). */
export const CALL_SOURCE_TYPES: readonly string[] = ["call_score", "transcript"];

export const KNOWLEDGE_SCOPE_DEFS: readonly KnowledgeScopeDef[] = [
  {
    id: "auto",
    label: "Auto",
    description: "The Brain picks the right knowledge for each question.",
    sensitive: false,
    retrieval: { lanes: null, raw: "auto", performance: "auto", callReview: "gated" },
  },
  {
    id: "all",
    label: "All Brain",
    description: "Search every lane at full weight: reality, learning, playbooks and platforms.",
    sensitive: false,
    retrieval: {
      lanes: { reality: 1, learning: 1, playbook: 1, platform: 1 },
      raw: "always",
      performance: "auto",
      callReview: "gated",
    },
  },
  {
    id: "reality",
    label: "Reality",
    description: "What is true today: company facts, reports, KPIs and the raw archive.",
    sensitive: false,
    retrieval: { lanes: { reality: 1 }, raw: "always", performance: "numbers", callReview: "gated" },
  },
  {
    id: "playbook",
    label: "Playbooks",
    description: "Frameworks and methods we believe in, and how to apply them.",
    sensitive: false,
    retrieval: { lanes: { playbook: 1 }, raw: "never", performance: "never", callReview: "off" },
  },
  {
    id: "learning",
    label: "Learnings",
    description: "What PractiScale tried, what happened and what we learned.",
    sensitive: false,
    retrieval: { lanes: { learning: 1 }, raw: "never", performance: "never", callReview: "off" },
  },
  {
    id: "calls",
    label: "Consultant calls",
    description: "Sales-call transcripts and AI call scores only.",
    sensitive: true,
    // Call documents live in the Business Reality lane (transcripts are written
    // as business_reality; call_score rows carry no class, which means reality).
    retrieval: {
      lanes: { reality: 1 },
      raw: "never",
      performance: "never",
      callReview: "forced",
      sourceTypes: CALL_SOURCE_TYPES,
    },
    unavailableNote:
      "No consultant call data is available to you, so I can't search calls. Choose another option under Search in (for example Auto) and ask again.",
  },
];

export const KNOWLEDGE_SCOPE_IDS = KNOWLEDGE_SCOPE_DEFS.map((s) => s.id) as [KnowledgeScopeId, ...KnowledgeScopeId[]];

export const DEFAULT_KNOWLEDGE_SCOPE: KnowledgeScopeId = "auto";

const DEF_BY_ID = new Map<string, KnowledgeScopeDef>(KNOWLEDGE_SCOPE_DEFS.map((s) => [s.id, s]));

export function isKnowledgeScope(v: unknown): v is KnowledgeScopeId {
  return typeof v === "string" && DEF_BY_ID.has(v);
}

/** The scope's definition; anything unknown (or missing) is Auto. */
export function knowledgeScopeDef(v: unknown): KnowledgeScopeDef {
  return (typeof v === "string" ? DEF_BY_ID.get(v) : undefined) ?? DEF_BY_ID.get(DEFAULT_KNOWLEDGE_SCOPE)!;
}

/**
 * Whether a key whose scope is `keySourceTypes` (empty = unrestricted) can EVER
 * reach what the scope searches. A scope without a source-type restriction is
 * always reachable; a restricted one needs an unrestricted key or an overlap.
 * Mirrors keyAllowsSensitive (lib/knowledge-read): unrestricted, or restricted
 * to a set that includes the scope's source types.
 */
export function scopeReachableByKey(scope: KnowledgeScopeDef, keySourceTypes: readonly string[] | null | undefined): boolean {
  const need = scope.retrieval.sourceTypes;
  if (!need || need.length === 0) return true;
  const st = keySourceTypes ?? [];
  return st.length === 0 || st.some((t) => need.includes(t));
}

/** The answer when a scope's data is unreachable for the caller (its source types intersect to nothing). */
export function scopeUnavailableMessage(scope: KnowledgeScopeDef): string {
  return (
    scope.unavailableNote ??
    `No ${scope.label} knowledge is available to you, so I can't search there. Choose another option under Search in (for example Auto) and ask again.`
  );
}

/** The public projection a spoke renders: `{ id, label, description, sensitive }`. */
export interface PublicKnowledgeScope {
  id: KnowledgeScopeId;
  label: string;
  description: string;
  sensitive: boolean;
}

/** The scopes to advertise to a key — those its source-type scope can ever reach, in catalogue order. */
export function scopesForKey(key: { source_types?: string[] | null }): PublicKnowledgeScope[] {
  return KNOWLEDGE_SCOPE_DEFS.filter((s) => scopeReachableByKey(s, key.source_types)).map(({ id, label, description, sensitive }) => ({
    id,
    label,
    description,
    sensitive,
  }));
}

// ---------------------------------------------------------------------------
// Lane plan (pure; the orchestrator's step 3)
// ---------------------------------------------------------------------------

export interface LanePlan {
  /** Weight per lane in [0,1] (0 = silent). */
  weights: Record<Lane, number>;
  /** Lanes to search, in LANES order (performance excluded: it is a block, not a search). */
  active: Lane[];
  /** Also search the raw archive (weight 0.3). */
  includeRaw: boolean;
  /** Fetch the Performance Memory block. */
  wantsPerformance: boolean;
  callReview: KnowledgeScopeRetrieval["callReview"];
  /** A fixed scope: relationship expansion stays inside the searched lanes. */
  restrictToActive: boolean;
}

/** Below this weight a lane is not searched. */
export const MIN_ACTIVE_LANE_WEIGHT = 0.15;

/**
 * The lane plan for a request. Auto (or any unknown id) = today's behaviour:
 * policy weight × intent weight (sqrt, either can silence a lane), Business
 * Reality floored at 0.5, raw archive for analysts on analyze asks, Performance
 * Memory when its weight is ≥ 0.3 or the question needs numbers. A fixed scope
 * replaces the weights with its own (no reality floor unless it selects
 * reality) and sets raw / performance / call review per the catalogue.
 */
export function planLaneWeights(
  scope: string | null | undefined,
  policy: Pick<RetrievalPolicy, "lanes" | "includeRaw">,
  intent: { lanes: Partial<Record<Lane, number>>; intentKind: IntentKind; needsNumbers: boolean }
): LanePlan {
  const def = knowledgeScopeDef(scope);
  const r = def.retrieval;

  const auto: Record<Lane, number> = { reality: 0, learning: 0, playbook: 0, platform: 0, performance: 0 };
  for (const l of LANES) auto[l] = Math.max(0, Math.min(1, Math.sqrt(policy.lanes[l] * (intent.lanes[l] ?? 0.5))));

  let weights: Record<Lane, number>;
  if (r.lanes === null) {
    weights = { ...auto };
    // Reality is never silenced entirely (it is the evidence).
    weights.reality = Math.max(weights.reality, 0.5);
  } else {
    weights = { reality: 0, learning: 0, playbook: 0, platform: 0, performance: 0 };
    for (const [lane, w] of Object.entries(r.lanes) as [SearchLane, number][]) weights[lane] = Math.max(0, Math.min(1, w));
    // The performance weight is only meaningful when the block follows the per-question rule.
    if (r.performance === "auto") weights.performance = auto.performance;
  }

  const active = LANES.filter((l) => l !== "performance" && weights[l] >= MIN_ACTIVE_LANE_WEIGHT);
  const autoRaw = !!policy.includeRaw && intent.intentKind === "analyze";
  const includeRaw = r.raw === "always" ? true : r.raw === "never" ? false : autoRaw;
  const wantsPerformance =
    r.performance === "auto" ? weights.performance >= 0.3 || intent.needsNumbers : r.performance === "numbers" ? intent.needsNumbers : false;

  return { weights, active, includeRaw, wantsPerformance, callReview: r.callReview, restrictToActive: r.lanes !== null };
}
