import { describe, it, expect, vi, beforeEach } from "vitest";

// POST /api/v1/chat — `capabilities` (the spoke user's resolved grants) can only
// NARROW a request, and Performance Memory reaches a caller only when call
// scores are in their effective scope. The key lookup, DB, orchestrator,
// learning detector and model are mocked (no network); the route runs for real.
const m = vi.hoisted(() => ({
  bridge: false,
  payroll: vi.fn(),
  resolveContext: vi.fn(),
  orchestrate: vi.fn(),
  insert: vi.fn(),
  detect: vi.fn(),
  streamText: vi.fn(),
  readDocumentDates: vi.fn(),
  readSavedChunks: vi.fn(),
  requireSourcePermission: vi.fn(),
  readGhlOpportunity: vi.fn(),
}));

vi.mock("@/lib/auth/context", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/context")>()),
  resolveContext: m.resolveContext,
}));
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === "documents") return { select: () => ({ eq: () => ({ in: m.readDocumentDates }) }) };
      if (table === "chunks") {
        const builder = { select: () => builder, eq: () => builder, in: () => builder, limit: () => builder, abortSignal: m.readSavedChunks };
        return builder;
      }
      return { insert: m.insert };
    },
  }),
}));
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

vi.mock('@/lib/connectors/payroll-report',()=>({payrollAccess:()=>m.bridge}));
vi.mock('@/lib/connectors/source-access',()=>({requireSourcePermission:m.requireSourcePermission,requireSourceIdentity:async()=> 'verified@example.com'}));
vi.mock('@/lib/connectors/ghl-opportunity',async orig=>({...await orig<typeof import('@/lib/connectors/ghl-opportunity')>(),readGhlOpportunity:m.readGhlOpportunity}));
vi.mock('@/lib/connectors/payroll-live',async orig=>({...await orig<typeof import('@/lib/connectors/payroll-live')>(),readLivePayroll:m.payroll}));
import { POST as chat } from "@/app/api/v1/chat/route";
import { GET as readCitation } from "@/app/api/v1/citations/[id]/route";
import { demoSavedAnswerSources as savedSources } from "@/lib/demo/stream";
import { UnsupportedPayrollTicketReportError } from '@/lib/connectors/payroll-live';

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

const savedHistory = (question: string) => [
  { role: "user", content: "What does the appointment reminder playbook recommend?" },
  { role: "assistant", content: [
    "Here's the breakdown:",
    `1. Send the first reminder 24 hours before the appointment. [${savedSources[0].id}]`,
    `2. If the buyer has not confirmed, send a second reminder 2 hours before the appointment. [${savedSources[1].id}]`,
    `3. Track show-up rate weekly using attended appointments divided by scheduled appointments. [${savedSources[2].id}]`,
  ].join("\n") },
  { role: "user", content: question },
];

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
  m.bridge=false;
  m.requireSourcePermission.mockResolvedValue("verified@example.com");
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

it.each([
  ["Turn that into a table.", "Point | Details"],
  ["Make it shorter.", "first reminder 24 hours"],
  ["Explain point two.", "buyers who have already confirmed do not receive another reminder"],
])("answers a cited saved follow-up without broad search or a model (%s)", async (question, expected) => {
  m.readSavedChunks.mockResolvedValueOnce({ data: savedSources, error: null });
  const { res, text } = await send(["document"], { savedConversation: true, messages: savedHistory(question) });
  expect(res.headers.get("x-model")).toBe("none");
  expect(text).toContain(expected);
  const referenced = events(text).find(event => event.type === "sources")?.sources as { id: string }[];
  expect(referenced.map(source => source.id)).toEqual(question.startsWith("Explain")
    ? [savedSources[1].id] : savedSources.map(source => source.id));
  expect(text).toContain(`[${savedSources[1].id}]`);
  expect(m.orchestrate).not.toHaveBeenCalled();
  expect(m.streamText).not.toHaveBeenCalled();
});

it("uses normal search and generation when the saved source cannot be reopened", async () => {
  m.readSavedChunks.mockResolvedValueOnce({ data: [savedSources[0]], error: null });
  const { res } = await send(["document"], { savedConversation: true, messages: savedHistory("Turn that into a table.") });
  expect(res.headers.get("x-model")).toBe("claude-haiku-4-5");
  expect(m.orchestrate).toHaveBeenCalledTimes(1);
  expect(m.streamText).toHaveBeenCalledTimes(1);
});

it("starts generation while citation dates load and emits sources before the answer", async () => {
  const docId = "doc-1";
  const chunk = { id: "ch-1", document_id: docId, content: "Follow-up cadence notes.", source_type: "document" };
  m.orchestrate.mockResolvedValueOnce(retrieval([], {
    chunks: [chunk],
    annotated: [{ ...chunk, lane: "reality", object: null, via: "search" }],
  }));
  let releaseDates!: (result: { data: { id: string; updated_at: string }[] }) => void;
  m.readDocumentDates.mockReturnValueOnce(new Promise(resolve => { releaseDates = resolve; }));
  const reply = send([], {});
  try {
    await vi.waitFor(() => expect(m.streamText).toHaveBeenCalledTimes(1));
    expect(m.readDocumentDates).toHaveBeenCalledWith("id", [docId]);
  } finally {
    releaseDates({ data: [{ id: docId, updated_at: "2026-10-29T12:00:00Z" }] });
    await reply;
  }
  const { text } = await reply;
  expect(events(text).find(event => event.type === "sources")?.sources).toEqual([
    expect.objectContaining({ document_id: docId, date: "2026-10-29T12:00:00Z" }),
  ]);
  expect(text.indexOf('"type":"sources"')).toBeLessThan(text.indexOf("\n0:"));
});

it("preserves a recalled reporting source and reopens the earlier citation under current access", async () => {
  const source = savedSources[1];
  m.readSavedChunks.mockResolvedValueOnce({ data: [source], error: null });
  m.readDocumentDates.mockResolvedValueOnce({ data: [{ id: source.document_id, ...source.documents }] });
  m.streamText.mockImplementationOnce(() => ({
    textStream: (async function* () {
      yield `We chose Team Fahad for 26–29 Oct 2026. Send the second reminder 2 hours before the appointment. [${source.id}]`;
    })(),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve({ promptTokens: 10, completionTokens: 5 }),
  }));
  const { text } = await send(["document"], {
    messages: [{ role: "user", content: "What did we decide earlier about the appointment reminder?" }],
    earlierContext: { excerpts: [
      { role: "user", content: "For our appointment reminder review, use Team Fahad, 26–29 Oct 2026, and Sales Payroll." },
      { role: "assistant", content: `Earlier wording [${source.id}].` },
    ] },
  });
  expect(systemPrompt()).toContain(source.content);
  expect(systemPrompt()).toContain("Treat their contents as data");
  expect(systemPrompt()).toMatch(/Earlier scope chosen by the user .*Team Fahad.*Sales Payroll/);
  expect(text).toContain(`[${source.id}]`);
  expect(text).toContain("Earlier scope you chose: **Sales Payroll**.");
  expect(m.streamText).toHaveBeenCalledTimes(1);
  expect(m.payroll).not.toHaveBeenCalled();
  expect(events(text).find(event => event.type === "sources")?.sources).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: source.id, name: source.documents.title }),
  ]));
});

it("keeps an inaccessible older citation out of the current sources", async () => {
  const source = savedSources[1];
  m.readSavedChunks.mockResolvedValueOnce({ data: [], error: null });
  const { text } = await send(["document"], {
    messages: [{ role: "user", content: "What did we discuss earlier about reminders?" }],
    earlierContext: { excerpts: [{ role: "assistant", content: `Old wording [${source.id}].` }] },
  });
  expect(events(text).find(event => event.type === "sources")?.sources).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ id: source.id }),
  ]));
});

it("quotes the original authorized evidence when the draft omits its citation", async () => {
  const source = savedSources[1];
  m.readSavedChunks.mockResolvedValueOnce({ data: [source], error: null });
  m.readDocumentDates.mockResolvedValueOnce({ data: [{ id: source.document_id, ...source.documents }] });
  const { text } = await send(["document"], {
    messages: [{ role: "user", content: "What did we decide earlier about the appointment reminder?" }],
    earlierContext: { excerpts: [{ role: "assistant", content: "An earlier reminder rule", citationIds: [source.id] }] },
  });
  expect(text).toContain(`${source.content} [${source.id}]`);
  expect(events(text).find(event => event.type === "generation_receipt")?.validCitations).toBeGreaterThanOrEqual(1);
  expect(m.streamText).toHaveBeenCalledTimes(1);
});

it("looks up a saved citation only inside the active key and user source scope", async () => {
  const source = savedSources[1];
  const request = (params = "") => readCitation(new Request(`http://localhost/api/v1/citations/${source.id}${params}`),
    { params: Promise.resolve({ id: source.id }) });
  m.resolveContext.mockResolvedValueOnce(ctx(["document"]));
  m.readSavedChunks.mockResolvedValueOnce({ data: [{ ...source, intelligence_class: "raw_archive", source_type: "document",
    documents: { ...source.documents, source_type: "document" } }], error: null });
  expect(await (await request()).json()).toMatchObject({ id: source.id, name: source.documents.title, snippet: source.content });
  m.readSavedChunks.mockClear();
  m.resolveContext.mockResolvedValueOnce(ctx(["document"]));
  expect((await request("?sourceType=transcript")).status).toBe(404);
  expect(m.readSavedChunks).not.toHaveBeenCalled();
});

it("returns a saved scorecard with its original excerpt, report date and zero score", async () => {
  const source = savedSources[1];
  m.resolveContext.mockResolvedValueOnce(ctx(["call_score"]));
  m.readSavedChunks.mockResolvedValueOnce({ data: [{ ...source, source_type: "call_score", documents: {
    ...source.documents, source_type: "call_score", call_date: "2026-11-18", reported_call_date: "2026-10-21",
    overall_score: 0, performance_band: "Requires Retraining",
  } }], error: null });
  const response = await readCitation(new Request(`http://localhost/api/v1/citations/${source.id}?sourceType=call_score`),
    { params: Promise.resolve({ id: source.id }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    id: source.id, document_id: source.document_id, source_type: "call_score", snippet: source.content,
    scorecard: { callDate: "2026-10-21", score: 0, band: "Requires Retraining" },
  });
});

it("emits a GHL citation without starting the model and rechecks pipeline access when it is opened", async () => {
  const id = "Mixed_CaseOpportunity123";
  const ref = `ghl-opportunity:${id}`;
  m.bridge = true;
  m.readGhlOpportunity.mockResolvedValue({ id, status: "won", pipelineId: "p", pipelineStageId: "s" });
  const { res, text } = await send([], { messages: [{ role: "user", content: `GHL opportunity ${id}` }] });
  expect(res.headers.get("x-model")).toBe("none");
  expect(text).toContain(`[${ref}]`);
  expect(m.streamText).not.toHaveBeenCalled();

  const read = () => readCitation(new Request(`http://localhost/api/v1/citations/${ref}`, {
    headers: { "x-chatbot-user-token": "current-session" },
  }), { params: Promise.resolve({ id: ref }) });
  m.resolveContext.mockResolvedValueOnce(ctx(["transcript"]));
  expect(await (await read()).json()).toMatchObject({ id: ref, source_type: "ghl_opportunity", opportunity: { id, status: "won", stageId: "s" } });
  expect(m.requireSourcePermission).toHaveBeenLastCalledWith("current-session", "pipeline.view", expect.any(AbortSignal));
  expect(m.readGhlOpportunity).toHaveBeenLastCalledWith(id, expect.any(AbortSignal));

  m.readGhlOpportunity.mockClear();
  m.resolveContext.mockResolvedValueOnce(ctx(["transcript"]));
  m.requireSourcePermission.mockRejectedValueOnce(Error("Access denied"));
  expect((await read()).status).toBe(404);
  m.resolveContext.mockResolvedValueOnce(ctx(["document"]));
  expect((await read()).status).toBe(404);
  expect(m.readGhlOpportunity).not.toHaveBeenCalled();
});

it("uses older user context to resolve a business follow-up outside the model window", async () => {
  const original = "What was Team Mike's appointment show rate in October 2026?";
  const followup = "Draft an email to our setters about this. Include the verified show rate.";
  await send([], {
    messages: [{ role: "user", content: followup }],
    earlierContext: { userTurns: [{ content: original }] },
  });
  expect(m.orchestrate.mock.calls[0]?.[0].query).toContain(original);
  expect(m.orchestrate.mock.calls[0]?.[0].query).toContain(followup);
});

describe("POST /api/v1/chat — absent capabilities keep today's behaviour", () => {
  it("emits conflicts, performance and a learning candidate; the prompt carries the numbers", async () => {
    const { res, text } = await send([], {});
    expect(res.headers.get("x-brain-deferred-learning")).toBe("1");
    expect(text.indexOf("\nd:")).toBeLessThan(text.indexOf('"type":"learning_candidate"'));
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

vi.mock("@/lib/ratelimit", async (original) => ({ ...(await original<typeof import("@/lib/ratelimit")>()), checkRateLimit: async () => ({ok:true,limit:120,remaining:119,retryAfter:60}) }));

it.each(['original turn', 'saved follow-up', 'compacted follow-up'])('keeps the date and person on the exact HT/LT pay prompt (%s)', async scenario => {
  m.bridge = true;
  m.payroll.mockResolvedValueOnce({
    report: 'ticket_commissions',
    from: '2026-11-01',
    through: '2026-11-19',
    date_basis: 'Recorded payslip commission for the exact Payroll run dates',
    fetched_at: '2026-11-20T10:00:00Z',
    data: { status: 'verified', person: 'Kate Melody', currency: 'PKR',
      low_ticket_minor: 2200000, high_ticket_minor: 3300000, calculated_at: '2026-11-19T08:30:00Z' },
  });
  const earlierReport = { content: 'Show HT and LT closing totals this month from Sales Payroll.', createdAt: '2026-11-18T21:38:00Z' };
  const savedConversation = scenario !== 'original turn';
  const { res, text } = await send([], {
    capabilities: ALL_CAPS,
    timeZone: 'Asia/Karachi',
    savedConversation,
    messages: [
      ...(scenario === 'saved follow-up' ? [
        { role: 'user', ...earlierReport },
        { role: 'assistant', content: 'Payroll report for 2026-11-01 to 2026-11-19. Combined closed value: USD 19,700.' },
      ] : []),
      {
        role: 'user',
        content: 'how in LT and HT earning by kate melody only?',
        createdAt: savedConversation ? '2026-11-20T10:00:00Z' : '2026-11-18T21:39:10Z',
      },
    ],
    earlierContext: { userTurns: scenario === 'compacted follow-up' ? [earlierReport] : [] },
  });

  expect(res.status).toBe(200);
  expect(m.payroll).toHaveBeenCalledTimes(1);
  expect(m.payroll).toHaveBeenCalledWith('ticket_commissions', 'verified@example.com', '2026-11-01', '2026-11-19', expect.any(AbortSignal), 'kate melody');
  expect(text).toContain('Requested period: 2026-11-01 to 2026-11-19');
  expect(text).toContain('**Kate Melody — recorded commissions**');
  expect(text).toContain('| High ticket (HT) | 33,000.00 |');
  expect(text).toContain('| Low ticket (LT) | 22,000.00 |');
  expect(text).toContain('[Sales Payroll](https://payroll.practicescalingsystems.com/admin)');
  expect(text).not.toMatch(/Another Consultant|150,000|90,000|Closed value|closing totals|19,700/);
  expect(m.streamText).not.toHaveBeenCalled();
});

it('keeps the source limitation when an older Payroll bridge lacks the commission report', async () => {
  m.bridge = true;
  m.payroll.mockRejectedValueOnce(new UnsupportedPayrollTicketReportError()).mockResolvedValueOnce({
    report: 'payroll', from: '2026-11-01', through: '2026-11-19', date_basis: 'Whole Payroll month', fetched_at: '2026-11-19T09:00:00Z',
    data: { bill: { people: [{ employee_id: 'kate', name: 'Kate Melody', role: 'consultant', minor: 9000000 }],
      run_status: 'open', last_recalculated_at: null, composition_reconciles: true } },
  });
  const { text } = await send([], { capabilities: ALL_CAPS, timeZone: 'Asia/Karachi', messages: [{
    role: 'user', content: 'how in LT and HT earning by kate melody only?', createdAt: '2026-11-18T21:39:10Z',
  }] });
  expect(m.payroll).toHaveBeenCalledTimes(2);
  expect(text).toContain('does not provide a verified earnings split');
  expect(text).not.toContain('90,000');
});

describe('company-grounded synthesis without paid providers',()=>{
 it.each(['Analyze Team Mike show rate this month','Draft a coaching email for Team Mike setters','Recommend next steps for our consultants','can we build any offer to consultants'])('keeps %s on the synthesis path with current authorized facts',async question=>{
  vi.stubEnv('PAYROLL_BRIDGE_KEY','mock-only');m.bridge=true;
  m.payroll.mockResolvedValue({report:'performance',from:'2026-11-01',through:'2026-11-18',date_basis:'reviewed outcomes',fetched_at:'2026-11-18T00:00:00Z',data:{teams:[{label:'Team Mike',showed:70,happened:413,show_rate:70/413}]}});
  try {
   const {text}=await send([], {capabilities:ALL_CAPS,messages:[{role:'user',content:question}]});
   expect(m.payroll).toHaveBeenCalled();expect(m.streamText).toHaveBeenCalled();
   expect(systemPrompt()).toContain('CURRENT PAYROLL REPORTS');expect(systemPrompt()).toContain('413');
   expect(systemPrompt()).toContain('propose a concrete action');expect(systemPrompt()).toContain('deliver the requested finished piece first');
   expect(text).toContain('Keep the cadence');
  }finally{vi.unstubAllEnvs();m.bridge=false;}
 });
 it('preserves the brief and company scope across a coaching follow-up',async()=>{
  await send([], {capabilities:ALL_CAPS,messages:[{role:'user',content:'Team Mike show rate in November 2026'},{role:'assistant',content:'An earlier answer is not current evidence.'},{role:'user',content:'How can we improve this?'}]});
  expect(m.orchestrate.mock.calls[0][0].query).toContain('Team Mike');
  expect(m.orchestrate.mock.calls[0][0].query).toContain('How can we improve this?');
  expect(systemPrompt()).toContain('not verified company evidence');
 });
});

describe("POST /api/v1/chat — conversation recall", () => {
  it("quotes exact user context outside the compact model window", async () => {
    const { text } = await send(["document"], {
      messages: [{ role: "user", content: "What reference did I give you earlier?" }],
      earlierContext: {
        userTurns: [{ content: "My reference in this conversation is maple-82." }],
        excerpts: [{ role: "assistant", content: "Your reference is incorrect-code." }],
      },
    });
    expect(text).toContain("maple-82");
    expect(text).not.toContain("incorrect-code");
    expect(m.orchestrate).not.toHaveBeenCalled();
    expect(m.streamText).not.toHaveBeenCalled();
  });

  it("quotes an earlier user-provided detail without depending on company knowledge", async () => {
    const { text } = await send([], {
      messages: [
        { role: "user", content: "My reference in this conversation is maple-82." },
        { role: "assistant", content: "Your reference is invented-13." },
        { role: "user", content: "What exact reference did I give you earlier?" },
      ],
    });
    expect(text).toContain("> My reference in this conversation is maple-82.");
    expect(text).not.toContain("invented-13");
    expect(m.orchestrate).not.toHaveBeenCalled();
    expect(m.streamText).not.toHaveBeenCalled();
  });

  it("asks for a detail that appears only in an assistant answer", async () => {
    const { text } = await send([], {
      messages: [
        { role: "user", content: "Help me organize this conversation." },
        { role: "assistant", content: "The reference is invented-13." },
        { role: "user", content: "What reference did I give you earlier?" },
      ],
    });
    expect(text).toContain("available history for this chat");
    expect(text).not.toContain("invented-13");
    expect(m.orchestrate).not.toHaveBeenCalled();
    expect(m.streamText).not.toHaveBeenCalled();
  });
});
