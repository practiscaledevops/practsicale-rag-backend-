import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `timeZone` on the public / admin APIs: POST /api/v1/chat forwards the user's
// zone to the orchestrator (an invalid one never 400s), POST /api/v1/compact
// dates its CURRENT DATE line in it, and both jobs routes resolve "today" in it
// and store it in the job params. Auth, DB, models, orchestrator and the job
// engine are mocked (no network).
const m = vi.hoisted(() => ({
  resolveContext: vi.fn(),
  requireAdmin: vi.fn(),
  orchestrate: vi.fn(),
  insert: vi.fn(),
  streamText: vi.fn(),
  generateText: vi.fn(),
  createJob: vi.fn(),
  planJob: vi.fn(),
  dispatchJob: vi.fn(),
  runRetrieval: vi.fn(),
}));

vi.mock("@/lib/auth/context", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/context")>()),
  resolveContext: m.resolveContext,
}));
vi.mock("@/lib/auth/admin", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/admin")>()),
  requireAdmin: m.requireAdmin,
}));
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => ({ from: () => ({ insert: m.insert }) }) }));
vi.mock("@/lib/orchestrator", async (orig) => ({
  ...(await orig<typeof import("@/lib/orchestrator")>()),
  runOrchestratedRetrieval: m.orchestrate,
}));
vi.mock("ai", async (orig) => ({ ...(await orig<typeof import("ai")>()), streamText: m.streamText, generateText: m.generateText }));
vi.mock("@/lib/llm", () => ({ getModel: vi.fn(async () => ({ modelId: "claude-haiku-4-5" })) }));
vi.mock("@/lib/prompts-db", () => ({ getActivePrompt: vi.fn(async () => "Answer only from the context.") }));
vi.mock("@/lib/query-log", () => ({ logQuery: vi.fn(async () => {}) }));
vi.mock("@/lib/chunk-retrieval-log", () => ({ logChunkRetrievals: vi.fn(async () => {}) }));
vi.mock("@/lib/learning-detect", () => ({ looksLikeLearning: () => false, detectLearning: vi.fn() }));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/lib/settings", async (orig) => {
  const real = await orig<typeof import("@/lib/settings")>();
  const settings = {
    ...real.DEFAULT_SETTINGS,
    features: { ...real.DEFAULT_SETTINGS.features, orchestrator: true, groundOrRefuse: true, learningDetection: false, faithfulnessCheck: false },
  };
  return { ...real, loadSettings: vi.fn(async () => ({ settings, updatedAt: null })) };
});
vi.mock("@/lib/pipeline", async (orig) => ({ ...(await orig<typeof import("@/lib/pipeline")>()), runRetrieval: m.runRetrieval }));
vi.mock("@/lib/jobs/engine", () => ({ createJob: m.createJob, planJob: m.planJob, listJobs: vi.fn(async () => []) }));
vi.mock("@/lib/jobs/dispatch", () => ({ dispatchJob: m.dispatchJob }));
vi.mock("@/lib/call-review", async (orig) => ({
  ...(await orig<typeof import("@/lib/call-review")>()),
  knownConsultants: vi.fn(async () => ["David Miller", "James Ephrim"]),
}));

import { POST as chat } from "@/app/api/v1/chat/route";
import { POST as compact } from "@/app/api/v1/compact/route";
import { POST as startJob } from "@/app/api/v1/jobs/route";
import { POST as startAdminJob } from "@/app/api/admin/jobs/route";
import { DEFAULT_TIME_ZONE, currentDateLine, todayIn } from "@/lib/timezone";
import { buildDateNote } from "@/lib/orchestrator";
import { DEFAULT_SETTINGS, loadSettings } from "@/lib/settings";

const NY = "America/New_York";
const PK = "Asia/Karachi";
// 20:00 EDT on Thursday 2026-09-24 = 05:00 on Friday 2026-09-25 in Karachi.
const EVENING_NY = new Date("2026-09-25T00:00:00Z");

let keySeq = 0;
function ctx() {
  // A fresh key id per call so the in-memory rate limiter never interferes.
  return {
    orgId: "org-1",
    key: { id: `tz-key-${++keySeq}`, capabilities: ["chat"], rate_limit_per_min: 100, source_types: [], data_source_ids: [], collection_ids: [] },
  };
}
function post(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { authorization: "Bearer psk_test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function retrieval(over: Record<string, unknown> = {}) {
  const chunk = { id: "ch-1", document_id: "", content: "Call notes.", source_type: "transcript", metadata: {}, parent_id: null, score: 0.8 };
  return {
    chunks: [chunk],
    effectiveQuery: "q",
    rewritten: false,
    sourceTypes: [],
    confidence: 0.8,
    intent: { workMode: "general", intentKind: "advise", primaryDomain: null, relatedDomains: [], problem: "", goal: "", keyConcepts: [], entities: [], needsNumbers: false, timeScope: "any", lanes: { reality: 1, learning: 0.6, playbook: 0.6, platform: 0.2, performance: 0.4 }, searchQueries: [], via: "heuristic" },
    mode: "general",
    auto: true,
    lanes: [],
    contextBlock: "[ch-1] Call notes.",
    performanceBlock: "",
    performanceMetrics: [],
    conflicts: [],
    objects: [],
    annotated: [{ ...chunk, lane: "reality", object: null, via: "search" }],
    fallback: false,
    callReview: undefined,
    ...over,
  };
}
function events(text: string): { type: string; [k: string]: unknown }[] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("2:"))
    .flatMap((l) => JSON.parse(l.slice(2)) as { type: string }[]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(EVENING_NY);
  m.resolveContext.mockImplementation(async () => ctx());
  m.requireAdmin.mockResolvedValue({ orgId: "org-1", userId: "user-1" });
  m.insert.mockResolvedValue({ error: null });
  m.orchestrate.mockImplementation(async () => retrieval());
  m.streamText.mockImplementation(() => ({
    textStream: (async function* () {
      yield "Here are today's calls [ch-1].";
    })(),
    finishReason: Promise.resolve("stop"),
    usage: Promise.resolve({ promptTokens: 10, completionTokens: 5 }),
  }));
  m.generateText.mockResolvedValue({ text: "- Summary", usage: { promptTokens: 10, completionTokens: 5 } });
  m.createJob.mockImplementation(async (input: { title: string; params: Record<string, unknown> }) => ({ id: "job-1", title: input.title, params: input.params }));
  m.planJob.mockResolvedValue(2);
  m.dispatchJob.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/v1/chat — timeZone", () => {
  const messages = [{ role: "user", content: "list all today's calls" }];

  it("forwards the user's zone to the orchestrator", async () => {
    const res = await chat(post("/api/v1/chat", { messages, timeZone: NY }));
    expect(res.status).toBe(200);
    await res.text();
    expect(m.orchestrate.mock.calls[0][0].timeZone).toBe(NY);
  });

  it("normalises the spelling and trims", async () => {
    await (await chat(post("/api/v1/chat", { messages, timeZone: " america/new_york " }))).text();
    expect(m.orchestrate.mock.calls[0][0].timeZone).toBe(NY);
  });

  it("absent or invalid → the default zone, never a 400", async () => {
    for (const timeZone of [undefined, "Mars/Olympus_Mons", "+05:00", 42, { tz: NY }, "x".repeat(500)]) {
      m.orchestrate.mockClear();
      const res = await chat(post("/api/v1/chat", { messages, ...(timeZone === undefined ? {} : { timeZone }) }));
      expect(res.status).toBe(200);
      await res.text();
      expect(m.orchestrate.mock.calls[0][0].timeZone).toBe(DEFAULT_TIME_ZONE);
    }
  });

  it("tells the orchestrator whether the zone was the caller's (timeZoneFromUser)", async () => {
    for (const timeZone of [NY, " america/new_york "]) {
      m.orchestrate.mockClear();
      await (await chat(post("/api/v1/chat", { messages, timeZone }))).text();
      expect(m.orchestrate.mock.calls[0][0]).toMatchObject({ timeZone: NY, timeZoneFromUser: true });
    }
    for (const timeZone of [undefined, "Mars/Olympus_Mons", "+05:00", 42]) {
      m.orchestrate.mockClear();
      await (await chat(post("/api/v1/chat", { messages, ...(timeZone === undefined ? {} : { timeZone }) }))).text();
      expect(m.orchestrate.mock.calls[0][0]).toMatchObject({ timeZone: DEFAULT_TIME_ZONE, timeZoneFromUser: false });
    }
  });

  it("the classic pipeline (orchestrator off) leads the context with the CURRENT DATE note too", async () => {
    const settings = { ...DEFAULT_SETTINGS, features: { ...DEFAULT_SETTINGS.features, orchestrator: false, groundOrRefuse: true, learningDetection: false, faithfulnessCheck: false } };
    m.runRetrieval.mockResolvedValue({
      chunks: [{ id: "ch-1", document_id: "", content: "Call notes.", source_type: "transcript", metadata: {}, parent_id: null, score: 0.8 }],
      effectiveQuery: "q",
      rewritten: false,
      sourceTypes: [],
      confidence: 0.8,
    });
    const cases: [unknown, string][] = [
      [NY, buildDateNote(NY, EVENING_NY.getTime(), true)],
      [undefined, buildDateNote(DEFAULT_TIME_ZONE, EVENING_NY.getTime(), false)],
    ];
    for (const [timeZone, note] of cases) {
      m.streamText.mockClear();
      vi.mocked(loadSettings).mockResolvedValueOnce({ settings, updatedAt: null });
      const res = await chat(post("/api/v1/chat", { messages, ...(timeZone === undefined ? {} : { timeZone }) }));
      expect(res.status).toBe(200);
      await res.text();
      expect(m.orchestrate).not.toHaveBeenCalled();
      const { system } = m.streamText.mock.calls[0][0] as { system: string };
      expect(system).toContain(`Context:\n${note}\n\n\n`);
    }
  });

  it("the call_review event names the zone of its dates", async () => {
    m.orchestrate.mockImplementationOnce(async () =>
      retrieval({ callReview: { count: 1, note: null, filter: { isReview: true, date: "2026-09-24" }, timeZone: NY } })
    );
    const res = await chat(post("/api/v1/chat", { messages, timeZone: NY }));
    const ev = events(await res.text()).find((e) => e.type === "call_review");
    expect(ev).toMatchObject({ count: 1, filter: { date: "2026-09-24" }, timeZone: NY });
  });
});

describe("POST /api/v1/compact — timeZone", () => {
  const messages = [{ role: "user", content: "list yesterday's calls" }, { role: "assistant", content: "Here are the calls …" }];

  it("the CURRENT DATE line is the user's date, weekday, zone and offset", async () => {
    expect((await compact(post("/api/v1/compact", { messages, timeZone: NY }))).status).toBe(200);
    const { prompt } = m.generateText.mock.calls[0][0] as { prompt: string };
    expect(prompt.startsWith("CURRENT DATE: 2026-09-24 (Thursday), America/New_York, UTC−04:00\n\n")).toBe(true);
  });

  it("a Karachi user at the same instant gets Karachi's date", async () => {
    await compact(post("/api/v1/compact", { messages, timeZone: PK }));
    const { prompt } = m.generateText.mock.calls[0][0] as { prompt: string };
    expect(prompt.startsWith("CURRENT DATE: 2026-09-25 (Friday), Asia/Karachi, UTC+05:00\n\n")).toBe(true);
  });

  it("absent or invalid → the default zone, not a 400", async () => {
    for (const timeZone of [undefined, "Mars/Olympus_Mons", 7]) {
      m.generateText.mockClear();
      const res = await compact(post("/api/v1/compact", { messages, ...(timeZone === undefined ? {} : { timeZone }) }));
      expect(res.status).toBe(200);
      const { prompt } = m.generateText.mock.calls[0][0] as { prompt: string };
      expect(prompt.startsWith(`${currentDateLine(DEFAULT_TIME_ZONE, EVENING_NY)}\n\n`)).toBe(true);
    }
  });
});

describe("POST /api/v1/jobs — the zone is resolved and stored in the job params", () => {
  it("'deep audit of today's calls' from New York at 20:00 EDT → New York's date + params.timeZone", async () => {
    const res = await startJob(post("/api/v1/jobs", { query: "deep audit of today's calls", timeZone: NY }));
    expect(res.status).toBe(201);
    const { params, title } = m.createJob.mock.calls[0][0] as { params: Record<string, unknown>; title: string };
    expect(params).toMatchObject({ date: "2026-09-24", timeZone: NY });
    expect(title).toContain("2026-09-24");
  });

  it("the same request from Karachi → Karachi's date", async () => {
    await startJob(post("/api/v1/jobs", { query: "deep audit of today's calls", timeZone: PK }));
    expect((m.createJob.mock.calls[0][0] as { params: Record<string, unknown> }).params).toMatchObject({ date: "2026-09-25", timeZone: PK });
  });

  it("history createdAt anchors in the requester's zone", async () => {
    // Sent 21:00 EDT on the 24th (already the 25th in Karachi).
    const history = [
      { role: "user", content: "list yesterday's calls", createdAt: "2026-09-25T01:00:00Z" },
      { role: "assistant", content: "Here are the calls …" },
    ];
    vi.setSystemTime(new Date("2026-09-26T15:00:00Z"));
    await startJob(post("/api/v1/jobs", { query: "deep audit of them", history, timeZone: NY }));
    expect((m.createJob.mock.calls[0][0] as { params: Record<string, unknown> }).params).toMatchObject({ date: "2026-09-23", timeZone: NY });
  });

  it("absent or invalid zone → the default zone is stored (no 400)", async () => {
    for (const timeZone of [undefined, "Nowhere/Land", 12]) {
      m.createJob.mockClear();
      const res = await startJob(post("/api/v1/jobs", { query: "deep audit of today's calls", ...(timeZone === undefined ? {} : { timeZone }) }));
      expect(res.status).toBe(201);
      expect((m.createJob.mock.calls[0][0] as { params: Record<string, unknown> }).params).toMatchObject({
        date: todayIn(DEFAULT_TIME_ZONE, EVENING_NY),
        timeZone: DEFAULT_TIME_ZONE,
      });
    }
  });
});

describe("POST /api/admin/jobs — the zone is resolved and stored in the job params", () => {
  it("natural-language path: the requester's today + params.timeZone", async () => {
    const res = await startAdminJob(post("/api/admin/jobs", { query: "deep audit of yesterday's calls", timeZone: NY }));
    expect(res.status).toBe(201);
    const input = m.createJob.mock.calls[0][0] as { type: string; params: Record<string, unknown> };
    expect(input.type).toBe("deep_call_audit");
    expect(input.params).toMatchObject({ date: "2026-09-23", timeZone: NY });
  });

  it("typed path: a request-level zone is added; an explicit params.timeZone is kept", async () => {
    await startAdminJob(post("/api/admin/jobs", { type: "deep_call_audit", title: "Audit", params: { date: "2026-09-24" }, timeZone: NY }));
    expect((m.createJob.mock.calls[0][0] as { params: Record<string, unknown> }).params).toEqual({ date: "2026-09-24", timeZone: NY });
    await startAdminJob(post("/api/admin/jobs", { type: "deep_call_audit", title: "Audit", params: { date: "2026-09-24", timeZone: PK }, timeZone: NY }));
    expect((m.createJob.mock.calls[1][0] as { params: Record<string, unknown> }).params).toEqual({ date: "2026-09-24", timeZone: PK });
    // No request zone → params exactly as sent (the worker applies the default).
    await startAdminJob(post("/api/admin/jobs", { type: "deep_call_audit", title: "Audit", params: { date: "2026-09-24" } }));
    expect((m.createJob.mock.calls[2][0] as { params: Record<string, unknown> }).params).toEqual({ date: "2026-09-24" });
  });

  it("typed path: an invalid explicit params.timeZone is replaced by the request zone; a valid one is normalised", async () => {
    const invalid: unknown[] = ["+05:00", null, 123, "Nowhere/Land", ""];
    for (const [i, bad] of invalid.entries()) {
      await startAdminJob(post("/api/admin/jobs", { type: "deep_call_audit", title: "Audit", params: { date: "2026-09-24", timeZone: bad }, timeZone: NY }));
      expect((m.createJob.mock.calls[i][0] as { params: Record<string, unknown> }).params).toEqual({ date: "2026-09-24", timeZone: NY });
    }
    await startAdminJob(post("/api/admin/jobs", { type: "deep_call_audit", title: "Audit", params: { date: "2026-09-24", timeZone: " asia/karachi " }, timeZone: NY }));
    expect((m.createJob.mock.calls[invalid.length][0] as { params: Record<string, unknown> }).params).toEqual({ date: "2026-09-24", timeZone: PK });
  });

  it("an invalid zone falls back to the default", async () => {
    await startAdminJob(post("/api/admin/jobs", { query: "deep audit of today's calls", timeZone: "Nowhere/Land" }));
    expect((m.createJob.mock.calls[0][0] as { params: Record<string, unknown> }).params).toMatchObject({
      date: todayIn(DEFAULT_TIME_ZONE, EVENING_NY),
      timeZone: DEFAULT_TIME_ZONE,
    });
  });
});
