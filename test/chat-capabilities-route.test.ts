import { describe, it, expect, vi, beforeEach } from "vitest";

// POST /api/v1/chat — `capabilities` (the spoke user's resolved grants) can only
// NARROW a request, and Performance Memory reaches a caller only when call
// scores are in their effective scope. The key lookup, DB, orchestrator,
// learning detector and model are mocked (no network); the route runs for real.
const m = vi.hoisted(() => ({
  resolveContext: vi.fn(),
  orchestrate: vi.fn(),
  insert: vi.fn(),
  detect: vi.fn(),
  streamText: vi.fn(),
}));

vi.mock("@/lib/auth/context", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/context")>()),
  resolveContext: m.resolveContext,
}));
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => ({ from: () => ({ insert: m.insert }) }) }));
vi.mock("@/lib/orchestrator", async (orig) => ({
  ...(await orig<typeof import("@/lib/orchestrator")>()),
  runOrchestratedRetrieval: m.orchestrate,
}));
vi.mock("@/lib/learning-detect", () => ({ looksLikeLearning: () => true, detectLearning: m.detect }));
vi.mock("ai", async (orig) => ({ ...(await orig<typeof import("ai")>()), streamText: m.streamText }));
vi.mock("@/lib/llm", () => ({ getModel: vi.fn(async () => ({ modelId: "claude-haiku-4-5" })) }));
vi.mock("@/lib/prompts-db", () => ({ getActivePrompt: vi.fn(async () => "Answer only from the context.") }));
vi.mock("@/lib/query-log", () => ({ logQuery: vi.fn(async () => {}) }));
vi.mock("@/lib/chunk-retrieval-log", () => ({ logChunkRetrievals: vi.fn(async () => {}) }));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/lib/settings", async (orig) => {
  const real = await orig<typeof import("@/lib/settings")>();
  const settings = {
    ...real.DEFAULT_SETTINGS,
    features: { ...real.DEFAULT_SETTINGS.features, orchestrator: true, groundOrRefuse: true, learningDetection: true, faithfulnessCheck: false },
  };
  return { ...real, loadSettings: vi.fn(async () => ({ settings, updatedAt: null })) };
});

import { POST as chat } from "@/app/api/v1/chat/route";

const ALL_CAPS = ["chat.knowledge", "chat.source_scope", "chat.call_review", "knowledge.performance", "knowledge.conflicts", "learning.write"];
const QUESTION = "We tried a new follow-up cadence and our show-up rate went up — what should we do next?";
const PERF_BLOCK = "| Close rate | 2026-09-01 → 2026-09-30 | 17.2 % | consultant=David | call_scores |";
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
const CONFLICT = {
  a: { ref: "PB-001", name: "Call within 5 minutes", authority: "A1" },
  b: { ref: "PB-002", name: "Call the next day", authority: "B2" },
  note: "Speed-to-lead window",
};

let keySeq = 0;
function ctx(source_types: string[] = []) {
  // A fresh key id per test so the in-memory rate limiter never interferes.
  return {
    orgId: "org-1",
    key: { id: `cap-key-${++keySeq}`, capabilities: ["chat"], rate_limit_per_min: 100, source_types, data_source_ids: [], collection_ids: [] },
  };
}
function post(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/v1/chat", {
    method: "POST",
    headers: { authorization: "Bearer psk_test", "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: QUESTION }], ...body }),
  });
}

/** An orchestrator result with one source, a conflict and Performance Memory (the orchestrator is mocked). */
function retrieval(sourceTypes: string[], over: Record<string, unknown> = {}) {
  const chunk = { id: "ch-1", document_id: "", content: "Follow-up cadence notes.", source_type: "document", metadata: {}, parent_id: null, score: 0.8 };
  return {
    chunks: [chunk],
    effectiveQuery: QUESTION,
    rewritten: false,
    sourceTypes,
    confidence: 0.8,
    intent: { workMode: "general", intentKind: "advise", primaryDomain: null, relatedDomains: [], problem: "", goal: "", keyConcepts: [], entities: [], needsNumbers: true, timeScope: "any", lanes: { reality: 1, learning: 0.6, playbook: 0.6, platform: 0.2, performance: 0.4 }, searchQueries: [], via: "heuristic" },
    mode: "general",
    auto: true,
    lanes: [],
    contextBlock: "[ch-1] Follow-up cadence notes.",
    performanceBlock: PERF_BLOCK,
    performanceMetrics: [METRIC],
    conflicts: [CONFLICT],
    objects: [],
    annotated: [{ ...chunk, lane: "reality", object: null, via: "search" }],
    fallback: false,
    callReview: undefined,
    ...over,
  };
}

/** The data events (`2:[…]` lines) the stream carried. */
function events(text: string): { type: string; [k: string]: unknown }[] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("2:"))
    .flatMap((l) => JSON.parse(l.slice(2)) as { type: string }[]);
}
const types = (text: string) => events(text).map((e) => e.type);
/** The system prompt the (mocked) model was given, or null when no model call was made. */
const systemPrompt = (): string | null => (m.streamText.mock.calls[0]?.[0] as { system?: string } | undefined)?.system ?? null;

async function send(source_types: string[], body: Record<string, unknown>) {
  m.resolveContext.mockResolvedValueOnce(ctx(source_types));
  const res = await chat(post(body));
  return { res, text: await res.text() };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.insert.mockResolvedValue({ error: null });
  m.orchestrate.mockImplementation(async (o: { scope: { sourceTypes: string[] } }) => retrieval(o.scope.sourceTypes));
  m.detect.mockResolvedValue({
    kind: "experiment",
    title: "Faster follow-up cadence",
    change: "Follow up within a day",
    observedResult: "Show-up rate went up",
    department: "sales",
    relatedRefs: [],
    missingEvidence: [],
    confidence: 0.7,
  });
  m.streamText.mockImplementation(() => ({
    textStream: (async function* () {
      yield "Keep the cadence [ch-1].";
    })(),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve({ promptTokens: 10, completionTokens: 5 }),
  }));
});

describe("POST /api/v1/chat — capabilities validation", () => {
  it("rejects a malformed capability id", async () => {
    const { res } = await send([], { capabilities: ["Chat.Knowledge"] });
    expect(res.status).toBe(400);
    expect(m.orchestrate).not.toHaveBeenCalled();
  });

  it("rejects an over-long id and an over-long list", async () => {
    expect((await send([], { capabilities: ["a".repeat(81)] })).res.status).toBe(400);
    expect((await send([], { capabilities: Array.from({ length: 301 }, (_, i) => `modes.m${i}`) })).res.status).toBe(400);
    expect(m.orchestrate).not.toHaveBeenCalled();
  });

  it("accepts manifest-shaped ids (connectors, models, jobs) and forwards them to the orchestrator", async () => {
    const caps = [...ALL_CAPS, "tools.connector.hub-spot_crm", "models.claude-sonnet-4-6", "jobs.deep_audit", "app.projects"];
    const { res } = await send([], { capabilities: caps });
    expect(res.status).toBe(200);
    expect(m.orchestrate.mock.calls[0][0].capabilities).toEqual(caps);
  });
});

describe("POST /api/v1/chat — absent capabilities keep today's behaviour", () => {
  it("emits conflicts, performance and a learning candidate; the prompt carries the numbers", async () => {
    const { text } = await send([], {});
    expect(m.orchestrate.mock.calls[0][0].capabilities).toBeUndefined();
    expect(types(text)).toEqual(expect.arrayContaining(["conflicts", "performance", "learning_candidate"]));
    expect(systemPrompt()).toContain("PERFORMANCE MEMORY");
    expect(m.detect).toHaveBeenCalledTimes(1);
  });

  it("the full capability list behaves the same", async () => {
    const { text } = await send([], { capabilities: ALL_CAPS });
    expect(types(text)).toEqual(expect.arrayContaining(["conflicts", "performance", "learning_candidate"]));
    expect(systemPrompt()).toContain("PERFORMANCE MEMORY");
  });
});

describe("POST /api/v1/chat — each capability narrows its feature", () => {
  it("without knowledge.conflicts: no conflicts event (the rest is untouched)", async () => {
    const { text } = await send([], { capabilities: ALL_CAPS.filter((c) => c !== "knowledge.conflicts") });
    expect(types(text)).not.toContain("conflicts");
    expect(types(text)).toEqual(expect.arrayContaining(["performance", "learning_candidate"]));
  });

  it("without learning.write: learning detection never runs", async () => {
    const { text } = await send([], { capabilities: ALL_CAPS.filter((c) => c !== "learning.write") });
    expect(m.detect).not.toHaveBeenCalled();
    expect(types(text)).not.toContain("learning_candidate");
    expect(types(text)).toEqual(expect.arrayContaining(["conflicts", "performance"]));
  });

  it("without knowledge.performance: no performance event and no numbers in the prompt", async () => {
    const { text } = await send([], { capabilities: ALL_CAPS.filter((c) => c !== "knowledge.performance") });
    expect(types(text)).not.toContain("performance");
    expect(text).not.toContain("Close rate");
    expect(systemPrompt()).not.toContain("PERFORMANCE MEMORY");
    expect(systemPrompt()).not.toContain(PERF_BLOCK);
  });

  it("an empty list switches every gated feature off", async () => {
    const { text } = await send([], { capabilities: [] });
    expect(m.orchestrate.mock.calls[0][0].capabilities).toEqual([]);
    expect(types(text)).not.toContain("conflicts");
    expect(types(text)).not.toContain("performance");
    expect(types(text)).not.toContain("learning_candidate");
    expect(m.detect).not.toHaveBeenCalled();
  });

  it("numbers the caller may not see no longer bypass ground-or-refuse", async () => {
    m.orchestrate.mockImplementationOnce(async (o: { scope: { sourceTypes: string[] } }) => ({
      ...retrieval(o.scope.sourceTypes),
      chunks: [],
      annotated: [],
      conflicts: [],
    }));
    const { text } = await send([], { capabilities: ["chat.knowledge"] });
    expect(m.streamText).not.toHaveBeenCalled();
    expect(text).toMatch(/I don't have information about that/);
    expect(types(text)).not.toContain("performance");
  });
});

describe("POST /api/v1/chat — Performance Memory needs call scores in scope (leak fix)", () => {
  it("a key without call_score never gets the numbers, even with no capabilities sent", async () => {
    const { text } = await send(["document", "transcript"], {});
    expect(types(text)).not.toContain("performance");
    expect(text).not.toContain("Close rate");
    expect(systemPrompt()).not.toContain("PERFORMANCE MEMORY");
  });

  it("a spoke user narrowed away from call scores never gets them", async () => {
    const { text } = await send([], { sourceTypes: ["document"], capabilities: ALL_CAPS });
    expect(m.orchestrate.mock.calls[0][0].scope.sourceTypes).toEqual(["document"]);
    expect(types(text)).not.toContain("performance");
    expect(systemPrompt()).not.toContain("PERFORMANCE MEMORY");
  });

  it("asking for call_score cannot widen a key that lacks it", async () => {
    const { text } = await send(["document"], { sourceTypes: ["call_score"], capabilities: ALL_CAPS });
    expect(types(text)).not.toContain("performance");
  });

  it("a key (or narrowing) that includes call_score keeps them", async () => {
    const { text } = await send(["document", "call_score"], { sourceTypes: ["call_score", "document"], capabilities: ALL_CAPS });
    expect(types(text)).toContain("performance");
    expect(systemPrompt()).toContain(PERF_BLOCK);
  });
});

describe("POST /api/v1/chat — message timestamps", () => {
  it("createdAt reaches the call-review history but never the model", async () => {
    const at = "2026-09-24T10:00:00.000Z";
    const { res } = await send([], {
      messages: [
        { role: "user", content: "list yesterday's calls", createdAt: at },
        { role: "assistant", content: "Here are the calls …", createdAt: at },
        { role: "user", content: QUESTION, createdAt: "2026-09-25T09:00:00.000Z" },
      ],
    });
    expect(res.status).toBe(200);
    expect(m.orchestrate.mock.calls[0][0].history[0]).toEqual({ role: "user", content: "list yesterday's calls", createdAt: at });
    const sent = JSON.stringify((m.streamText.mock.calls[0][0] as { messages: unknown }).messages);
    expect(sent).toContain("list yesterday's calls");
    expect(sent).not.toContain("createdAt");
  });

  it("an over-long createdAt is a 400", async () => {
    const { res } = await send([], { messages: [{ role: "user", content: QUESTION, createdAt: "x".repeat(65) }] });
    expect(res.status).toBe(400);
  });
});
