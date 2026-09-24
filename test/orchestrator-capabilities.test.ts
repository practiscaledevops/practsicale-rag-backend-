import { describe, it, expect, vi, beforeEach } from "vitest";

// Capability narrowing + the Performance Memory scope gate in the orchestrator:
// the pure helpers, then runOrchestratedRetrieval itself with every I/O
// dependency mocked (no DB, no embeddings, no model) so we can see which reads
// it makes for a given scope / capability list.
const m = vi.hoisted(() => ({
  perf: vi.fn(),
  known: vi.fn(),
  fetchCalls: vi.fn(),
  contradictions: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => ({}) }));
vi.mock("@/lib/embeddings", () => ({ embed: vi.fn(async () => [0.1, 0.2]) }));
vi.mock("@/lib/retrieval", async (orig) => ({
  ...(await orig<typeof import("@/lib/retrieval")>()),
  hybridSearchLane: vi.fn(async () => []),
  expandParents: vi.fn(async (c: unknown[]) => c),
  expandTranscripts: vi.fn(async (_org: string, c: unknown[]) => c),
}));
vi.mock("@/lib/call-review", async (orig) => ({
  ...(await orig<typeof import("@/lib/call-review")>()),
  knownConsultants: m.known,
  fetchCallsByFilter: m.fetchCalls,
}));
vi.mock("@/lib/rerank", () => ({ rerank: vi.fn(async () => []) }));
vi.mock("@/lib/query-transform", () => ({ rewriteQueries: vi.fn(async (q: string) => [q]) }));
vi.mock("@/lib/prompts-db", () => ({ getActivePrompts: vi.fn(async () => ({ intent_classify: "", query_rewrite: "" })) }));
// No classifier model: the orchestrator falls back to the heuristic intent.
vi.mock("@/lib/structured", () => ({ structured: vi.fn(async () => null) }));
vi.mock("@/lib/pipeline", () => ({ runRetrieval: vi.fn() }));
vi.mock("@/lib/knowledge-store", () => ({
  getObjectsByIds: vi.fn(async () => new Map()),
  listRelationshipsFor: vi.fn(async () => []),
  listContradictionsAmong: m.contradictions,
}));
vi.mock("@/lib/performance-memory", async (orig) => ({
  ...(await orig<typeof import("@/lib/performance-memory")>()),
  fetchPerformanceBlock: m.perf,
}));

import {
  capabilityGates,
  callReviewInScope,
  performanceInScope,
  performanceAllowed,
  runOrchestratedRetrieval,
} from "@/lib/orchestrator";
import { narrowScope, narrowSourceTypes, type ScopeFilters } from "@/lib/auth/scope";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import type { ApiKeyRecord } from "@/lib/auth/context";

const ALL_CAPS = ["chat.knowledge", "chat.call_review", "knowledge.performance", "knowledge.conflicts", "learning.write"];
const scope = (sourceTypes: string[] = [], over: Partial<ScopeFilters> = {}): ScopeFilters => ({
  sourceTypes,
  dataSourceIds: [],
  collectionIds: [],
  ...over,
});
const key = (source_types: string[]) => ({ source_types, data_source_ids: [], collection_ids: [] }) as unknown as ApiKeyRecord;

describe("capabilityGates — narrow-only", () => {
  it("absent capabilities (an older client) keep every feature on", () => {
    expect(capabilityGates(undefined)).toEqual({ callReview: true, performance: true, learning: true, conflicts: true });
    expect(capabilityGates(null)).toEqual({ callReview: true, performance: true, learning: true, conflicts: true });
  });

  it("an empty list switches every gated feature off", () => {
    expect(capabilityGates([])).toEqual({ callReview: false, performance: false, learning: false, conflicts: false });
  });

  it("each gate opens only with its own id", () => {
    expect(capabilityGates(["chat.call_review"])).toEqual({ callReview: true, performance: false, learning: false, conflicts: false });
    expect(capabilityGates(["knowledge.performance"])).toEqual({ callReview: false, performance: true, learning: false, conflicts: false });
    expect(capabilityGates(["learning.write"])).toEqual({ callReview: false, performance: false, learning: true, conflicts: false });
    expect(capabilityGates(["knowledge.conflicts"])).toEqual({ callReview: false, performance: false, learning: false, conflicts: true });
    expect(capabilityGates(ALL_CAPS)).toEqual({ callReview: true, performance: true, learning: true, conflicts: true });
  });

  it("neighbouring ids do not open a gate", () => {
    const g = capabilityGates(["learning.read", "knowledge.map", "chat.knowledge", "data.call_score", "chat.call_review_x", "knowledge.performance.extra"]);
    expect(g).toEqual({ callReview: false, performance: false, learning: false, conflicts: false });
  });
});

describe("performanceInScope / performanceAllowed — the call-score leak fix", () => {
  it("unrestricted source types, or a set including call_score, is in scope", () => {
    expect(performanceInScope(scope([]))).toBe(true);
    expect(performanceInScope(scope(["call_score"]))).toBe(true);
    expect(performanceInScope(scope(["document", "call_score"]))).toBe(true);
  });

  it("a scope without call_score is out of scope (transcripts alone are not enough)", () => {
    expect(performanceInScope(scope(["document"]))).toBe(false);
    expect(performanceInScope(scope(["transcript"]))).toBe(false);
    expect(performanceInScope(scope(["document", "coaching"]))).toBe(false);
  });

  it("uses the EFFECTIVE scope: key ∩ spoke narrowing ∩ knowledge scope", () => {
    // Unrestricted key, spoke narrowed its user to documents → no numbers.
    expect(performanceInScope(narrowScope(key([]), { sourceTypes: ["document"] }))).toBe(false);
    // Key without call scores; the spoke asking for them cannot widen it.
    expect(performanceInScope(narrowScope(key(["document"]), { sourceTypes: ["call_score"] }))).toBe(false);
    // "calls" knowledge scope over a document-only key: narrowed to nothing.
    expect(performanceInScope(narrowSourceTypes(narrowScope(key(["document"]), null), ["call_score", "transcript"]))).toBe(false);
    // "calls" over an unrestricted key: call_score reachable.
    expect(performanceInScope(narrowSourceTypes(narrowScope(key([]), null), ["call_score", "transcript"]))).toBe(true);
  });

  it("needs both the scope and (when capabilities are sent) knowledge.performance", () => {
    expect(performanceAllowed(scope([]), capabilityGates(undefined))).toBe(true);
    expect(performanceAllowed(scope([]), capabilityGates(["knowledge.performance"]))).toBe(true);
    expect(performanceAllowed(scope([]), capabilityGates(["chat.knowledge"]))).toBe(false);
    // A granted capability never widens past the scope.
    expect(performanceAllowed(scope(["document"]), capabilityGates(["knowledge.performance"]))).toBe(false);
    expect(performanceAllowed(scope(["document"]), capabilityGates(undefined))).toBe(false);
  });
});

describe("callReviewInScope", () => {
  it("needs transcripts in scope and no data-source / collection narrowing", () => {
    expect(callReviewInScope(scope([]))).toBe(true);
    expect(callReviewInScope(scope(["transcript"]))).toBe(true);
    expect(callReviewInScope(scope(["call_score"]))).toBe(false);
    expect(callReviewInScope(scope([], { dataSourceIds: ["ds-1"] }))).toBe(false);
    expect(callReviewInScope(scope([], { collectionIds: ["c-1"] }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runOrchestratedRetrieval with mocked I/O
// ---------------------------------------------------------------------------

const settings = {
  ...DEFAULT_SETTINGS,
  features: { ...DEFAULT_SETTINGS.features, relationshipExpansion: false, rerank: false, queryRewrite: false },
};
const NUMBERS_Q = "What is our close rate this month?";
const REVIEW_Q = "Review all of yesterday's calls";
const METRIC = {
  id: "m-1",
  metric_key: "close_rate",
  label: "Close rate",
  entity_id: null,
  dimensions: { consultant: "David" },
  period_start: "2026-09-01",
  period_end: "2026-09-30",
  value: 17.2,
  unit: "%",
  source: "call_scores",
  object_id: null,
  note: null,
  created_at: "2026-09-24T00:00:00Z",
};

function run(query: string, s: ScopeFilters, extra: { capabilities?: string[]; knowledgeScope?: string } = {}) {
  return runOrchestratedRetrieval({ orgId: "org-1", query, history: [{ role: "user", content: query }], scope: s, settings, ...extra });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.perf.mockResolvedValue({ block: "| Close rate | 2026-09-01 → 2026-09-30 | 17.2 % | consultant=David | call_scores |", count: 1, keys: ["close_rate"], metrics: [METRIC] });
  m.known.mockResolvedValue(["David"]);
  m.fetchCalls.mockResolvedValue({ chunks: [], callCount: 0, note: null, scorecard: [], totalMatched: 0 });
  m.contradictions.mockResolvedValue([]);
});

describe("runOrchestratedRetrieval — Performance Memory scope gate", () => {
  it("unrestricted key, no capabilities: today's behaviour (numbers fetched)", async () => {
    const out = await run(NUMBERS_Q, scope([]));
    expect(m.perf).toHaveBeenCalledTimes(1);
    expect(out.performanceBlock).toContain("Close rate");
    expect(out.performanceMetrics).toHaveLength(1);
    expect(out.lanes.some((l) => l.lane === "performance")).toBe(true);
  });

  it("a scope that includes call_score still gets the numbers", async () => {
    await run(NUMBERS_Q, scope(["document", "call_score"]));
    expect(m.perf).toHaveBeenCalledTimes(1);
  });

  it("LEAK FIX: a scope without call_score never fetches per-consultant numbers", async () => {
    const out = await run(NUMBERS_Q, scope(["document"]));
    expect(m.perf).not.toHaveBeenCalled();
    expect(out.performanceBlock).toBe("");
    expect(out.performanceMetrics).toEqual([]);
    expect(out.lanes.some((l) => l.lane === "performance")).toBe(false);
  });

  it("LEAK FIX: transcripts without call scores are not enough", async () => {
    await run(NUMBERS_Q, scope(["transcript"]));
    expect(m.perf).not.toHaveBeenCalled();
  });

  it("capabilities without knowledge.performance skip the fetch", async () => {
    const out = await run(NUMBERS_Q, scope([]), { capabilities: ["chat.knowledge", "chat.call_review"] });
    expect(m.perf).not.toHaveBeenCalled();
    expect(out.performanceBlock).toBe("");
  });

  it("capabilities with knowledge.performance keep it (when call scores are in scope)", async () => {
    await run(NUMBERS_Q, scope([]), { capabilities: ["chat.knowledge", "knowledge.performance"] });
    expect(m.perf).toHaveBeenCalledTimes(1);
  });

  it("knowledge.performance cannot widen a scope without call scores", async () => {
    await run(NUMBERS_Q, scope(["document"]), { capabilities: ALL_CAPS });
    expect(m.perf).not.toHaveBeenCalled();
  });

  it("a knowledge scope that turns numbers off still wins (Playbooks)", async () => {
    await run(NUMBERS_Q, scope([]), { knowledgeScope: "playbook" });
    expect(m.perf).not.toHaveBeenCalled();
  });
});

describe("runOrchestratedRetrieval — call review gate", () => {
  it("no capabilities: a review ask runs the structured path (today's behaviour)", async () => {
    const out = await run(REVIEW_Q, scope([]));
    expect(m.known).toHaveBeenCalled();
    expect(m.fetchCalls).toHaveBeenCalledTimes(1);
    expect(out.callReview).toBeDefined();
  });

  it("with chat.call_review the structured path still runs", async () => {
    await run(REVIEW_Q, scope([]), { capabilities: ["chat.knowledge", "chat.call_review"] });
    expect(m.fetchCalls).toHaveBeenCalledTimes(1);
  });

  it("without chat.call_review the structured path never runs", async () => {
    const out = await run(REVIEW_Q, scope([]), { capabilities: ["chat.knowledge", "knowledge.performance"] });
    expect(m.known).not.toHaveBeenCalled();
    expect(m.fetchCalls).not.toHaveBeenCalled();
    expect(out.callReview).toBeUndefined();
  });

  it("without chat.call_review even the forced Consultant-calls scope skips it", async () => {
    await run(REVIEW_Q, scope([]), { capabilities: ["chat.knowledge"], knowledgeScope: "calls" });
    expect(m.fetchCalls).not.toHaveBeenCalled();
  });

  it("chat.call_review cannot widen a scope without transcripts", async () => {
    await run(REVIEW_Q, scope(["call_score"]), { capabilities: ALL_CAPS });
    expect(m.fetchCalls).not.toHaveBeenCalled();
  });

  const withSummary = (body: string, query: string) =>
    runOrchestratedRetrieval({
      orgId: "org-1",
      query,
      history: [{ role: "system", content: `[Conversation summary]\n${body}` }, { role: "user", content: query }],
      scope: scope([]),
      settings,
    });

  it("a compaction summary with no call filter does not open the gate (its marker is not review intent)", async () => {
    await withSummary("- User drafted a LinkedIn post about hiring.", "what next?");
    expect(m.known).not.toHaveBeenCalled();
    expect(m.fetchCalls).not.toHaveBeenCalled();
  });

  it("a compaction summary that carries a call filter still opens it for a short follow-up", async () => {
    await withSummary("- …\nActive call-review filter: date=2026-09-20 | consultants=James Ephrim", "and david?");
    expect(m.known).toHaveBeenCalled();
    expect(m.fetchCalls).toHaveBeenCalledTimes(1);
  });
});
