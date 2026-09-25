import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The asking user's time zone through the orchestrator (CURRENT DATE note,
// call-review filter + day bounds, scorecard label) and the deep-audit job
// handler (the zone stored in the job params). Every I/O dependency is mocked.
const m = vi.hoisted(() => ({
  known: vi.fn(),
  fetchCalls: vi.fn(),
  matchingDocs: vi.fn(),
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
  matchingCallDocs: m.matchingDocs,
}));
vi.mock("@/lib/rerank", () => ({ rerank: vi.fn(async () => []) }));
vi.mock("@/lib/query-transform", () => ({ rewriteQueries: vi.fn(async (q: string) => [q]) }));
vi.mock("@/lib/prompts-db", () => ({ getActivePrompts: vi.fn(async () => ({ intent_classify: "", query_rewrite: "" })) }));
vi.mock("@/lib/structured", () => ({ structured: vi.fn(async () => null) }));
vi.mock("@/lib/pipeline", () => ({ runRetrieval: vi.fn() }));
vi.mock("@/lib/knowledge-store", () => ({
  getObjectsByIds: vi.fn(async () => new Map()),
  listRelationshipsFor: vi.fn(async () => []),
  listContradictionsAmong: vi.fn(async () => []),
}));
vi.mock("@/lib/performance-memory", async (orig) => ({
  ...(await orig<typeof import("@/lib/performance-memory")>()),
  fetchPerformanceBlock: vi.fn(async () => null),
}));
vi.mock("@/lib/llm", () => ({ getModel: vi.fn(async () => ({ modelId: "claude-haiku-4-5" })) }));

import { runOrchestratedRetrieval, buildDateNote } from "@/lib/orchestrator";
import { hybridSearchLane, LANE_RPC_MISSING } from "@/lib/retrieval";
import { runRetrieval } from "@/lib/pipeline";
import { deepCallAuditHandler, paramsTimeZone } from "@/lib/jobs/deep-call-audit";
import { DEFAULT_TIME_ZONE, currentDateLine, todayIn } from "@/lib/timezone";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import type { Job, JobTask } from "@/lib/jobs/engine";

const NY = "America/New_York";
const PK = "Asia/Karachi";
// 20:00 EDT on Thursday 2026-09-24 = 05:00 on Friday 2026-09-25 in Karachi.
const EVENING_NY = new Date("2026-09-25T00:00:00Z");

const settings = {
  ...DEFAULT_SETTINGS,
  features: { ...DEFAULT_SETTINGS.features, relationshipExpansion: false, rerank: false, queryRewrite: false },
};
const SCOPE = { sourceTypes: [] as string[], dataSourceIds: [] as string[], collectionIds: [] as string[] };

function run(query: string, timeZone?: string | null, timeZoneFromUser?: boolean) {
  return runOrchestratedRetrieval({ orgId: "org-1", query, history: [{ role: "user", content: query }], scope: SCOPE, settings, timeZone, timeZoneFromUser });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Only the clock is faked (no timers), so the async pipeline runs normally.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(EVENING_NY);
  m.known.mockResolvedValue(["James Ephrim"]);
  m.fetchCalls.mockResolvedValue({ chunks: [], callCount: 0, note: null, scorecard: [], totalMatched: 0 });
  m.matchingDocs.mockResolvedValue({ docIds: [], scorecard: [] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("buildDateNote", () => {
  it("names the user's date, weekday, zone and offset", () => {
    expect(buildDateNote(NY, EVENING_NY.getTime())).toBe(
      "CURRENT DATE: 2026-09-24 (Thursday), America/New_York, UTC−04:00. This is the user's time zone: resolve \"today\", \"yesterday\", \"this week\", \"this month\" against this exact date, and give dates and times in this zone."
    );
    expect(buildDateNote(PK, EVENING_NY.getTime())).toMatch(/^CURRENT DATE: 2026-09-25 \(Friday\), Asia\/Karachi, UTC\+05:00\. /);
  });

  it("a defaulted zone (the caller sent none) is labelled the business zone, never the user's", () => {
    const note = buildDateNote(PK, EVENING_NY.getTime(), false);
    expect(note).toBe(
      "CURRENT DATE: 2026-09-25 (Friday), Asia/Karachi, UTC+05:00. The user's own time zone was not provided; these dates are in the business time zone Asia/Karachi. Resolve \"today\", \"yesterday\", \"this week\", \"this month\" against this date, label dates and times as Asia/Karachi, and never call them the user's local time."
    );
    expect(note).not.toContain("This is the user's time zone");
    expect(buildDateNote(PK, EVENING_NY.getTime(), true)).toContain("This is the user's time zone");
  });
});

describe("runOrchestratedRetrieval — the user's time zone", () => {
  it("a New York user at 20:00 EDT: 'today' is New York's date, in the note and the call filter", async () => {
    const out = await run("list all today's calls", NY, true);
    expect(out.contextBlock.startsWith("CURRENT DATE: 2026-09-24 (Thursday), America/New_York, UTC−04:00.")).toBe(true);
    expect(m.fetchCalls).toHaveBeenCalledTimes(1);
    const [, org, filter, opts] = m.fetchCalls.mock.calls[0];
    expect(org).toBe("org-1");
    expect(filter).toEqual({ isReview: true, date: "2026-09-24" });
    expect(opts).toEqual({ maxCalls: 25, maxTokens: 140_000, timeZone: NY });
    expect(out.callReview).toEqual({ count: 0, note: null, filter: { isReview: true, date: "2026-09-24" }, timeZone: NY });
  });

  it("a Karachi user at the same instant: Karachi's date", async () => {
    const out = await run("list all today's calls", PK, true);
    expect(out.contextBlock.startsWith("CURRENT DATE: 2026-09-25 (Friday), Asia/Karachi, UTC+05:00.")).toBe(true);
    expect(m.fetchCalls.mock.calls[0][2]).toEqual({ isReview: true, date: "2026-09-25" });
    expect(m.fetchCalls.mock.calls[0][3].timeZone).toBe(PK);
  });

  it("'yesterday' / 'last 3 days' for the New York user", async () => {
    await run("review yesterday's calls", NY);
    expect(m.fetchCalls.mock.calls[0][2]).toEqual({ isReview: true, date: "2026-09-23" });
    await run("review the calls from the last 3 days", NY);
    expect(m.fetchCalls.mock.calls[1][2]).toEqual({ isReview: true, dateFrom: "2026-09-22", dateTo: "2026-09-24" });
  });

  it("no zone, or an invalid one, uses the default zone", async () => {
    for (const tz of [undefined, null, "Mars/Olympus_Mons", "x".repeat(300)]) {
      m.fetchCalls.mockClear();
      const out = await run("list all today's calls", tz);
      expect(out.contextBlock.startsWith(`${currentDateLine(DEFAULT_TIME_ZONE, EVENING_NY)}.`)).toBe(true);
      expect(m.fetchCalls.mock.calls[0][2]).toEqual({ isReview: true, date: todayIn(DEFAULT_TIME_ZONE, EVENING_NY) });
      expect(m.fetchCalls.mock.calls[0][3].timeZone).toBe(DEFAULT_TIME_ZONE);
    }
  });

  it("the scorecard names its zone, carries local times and outranks transcript 'Call date' lines", async () => {
    m.fetchCalls.mockResolvedValueOnce({
      chunks: [],
      callCount: 0,
      note: null,
      totalMatched: 2,
      scorecard: [
        { date: "2026-09-24", time: "22:30", consultant: "James Ephrim", prospect: "Acme", practice: "NEMT", score: 82, band: null, outcome: null, duration: 12 },
        { date: "2026-09-24", time: null, consultant: "David Park", prospect: "Beta", practice: "NEMT", score: 70, band: null, outcome: null, duration: 9 },
      ],
    });
    const out = await run("list all today's calls", NY, true);
    expect(out.contextBlock).toContain(
      "SCORECARD — every matching call (date time | consultant → prospect | practice | score | band | outcome | duration). Dates and times are America/New_York local and AUTHORITATIVE. A \"Call date:\" line or the date in a transcript [locator] is the source's UTC/reported value and can be a day off; always report the scorecard's date and time:"
    );
    expect(out.contextBlock).toContain("1. 2026-09-24 22:30 | James Ephrim → Acme | NEMT | 82/100");
    expect(out.contextBlock).toContain("2. 2026-09-24 | David Park → Beta | NEMT | 70/100");
  });

  it("the note calls the zone the user's only when the caller sent it", async () => {
    const sent = await run("list all today's calls", NY, true);
    expect(sent.contextBlock).toContain("This is the user's time zone");
    // No flag (an older caller) or false: the zone was defaulted → business-zone wording.
    for (const flag of [undefined, false]) {
      const out = await run("list all today's calls", PK, flag);
      expect(out.contextBlock.startsWith("CURRENT DATE: 2026-09-25 (Friday), Asia/Karachi, UTC+05:00. The user's own time zone was not provided;")).toBe(true);
      expect(out.contextBlock).not.toContain("This is the user's time zone");
    }
  });

  it("pre-migration fallback (lane RPC missing): the CURRENT DATE note still leads the context", async () => {
    vi.mocked(hybridSearchLane).mockImplementation(async () => {
      throw new Error(LANE_RPC_MISSING);
    });
    vi.mocked(runRetrieval).mockResolvedValue({
      chunks: [{ id: "ch-1", content: "Call notes.", metadata: {}, document_id: "d1", parent_id: null, source_type: "transcript" }],
      effectiveQuery: "q",
      rewritten: false,
      sourceTypes: [],
      confidence: null,
    });
    try {
      const out = await run("list all today's calls", NY, true);
      expect(out.fallback).toBe(true);
      expect(out.contextBlock.startsWith(`${buildDateNote(NY, EVENING_NY.getTime(), true)}\n\n\n`)).toBe(true);
      expect(out.contextBlock).toContain("Call notes.");
    } finally {
      vi.mocked(hybridSearchLane).mockImplementation(async () => []);
    }
  });
});

// ---------------------------------------------------------------------------
// Deep-audit job handler: the zone rides in job.params
// ---------------------------------------------------------------------------

function job(params: Record<string, unknown>): Job {
  return {
    id: "job-1", org_id: "org-1", type: "deep_call_audit", title: "Deep audit", params, status: "running",
    total_tasks: 0, completed_tasks: 0, failed_tasks: 0, result: null, error: null, created_by: null,
    runner_ref: null, deadline_at: null, created_at: "", updated_at: "", finished_at: null,
  };
}

describe("deep_call_audit — the requester's zone from job params", () => {
  it("plan resolves day bounds in the stored zone", async () => {
    m.matchingDocs.mockResolvedValueOnce({
      docIds: ["d1"],
      scorecard: [{ date: "2026-09-24", consultant: "James Ephrim", prospect: "Acme", practice: "NEMT", score: 82, band: null, outcome: null, duration: 12 }],
    });
    const tasks = await deepCallAuditHandler.plan(job({ date: "2026-09-24", timeZone: NY }));
    expect(m.matchingDocs).toHaveBeenCalledWith(expect.anything(), "org-1", expect.objectContaining({ isReview: true, date: "2026-09-24" }), { timeZone: NY });
    expect(tasks).toHaveLength(1);
    expect((tasks[0].input.cards as { date: string }[])[0].date).toBe("2026-09-24");
  });

  it("an older job without a zone (or with an invalid one) uses the default zone", async () => {
    await deepCallAuditHandler.plan(job({ date: "2026-09-24" }));
    await deepCallAuditHandler.plan(job({ date: "2026-09-24", timeZone: "Nowhere/Land" }));
    expect(m.matchingDocs.mock.calls[0][3]).toEqual({ timeZone: DEFAULT_TIME_ZONE });
    expect(m.matchingDocs.mock.calls[1][3]).toEqual({ timeZone: DEFAULT_TIME_ZONE });
    expect(paramsTimeZone(undefined)).toBe(DEFAULT_TIME_ZONE);
  });

  it("the final report carries the zone for its labels", async () => {
    const done = { id: "t1", job_id: "job-1", org_id: "org-1", idx: 0, label: "Batch 1", status: "completed", input: {}, result: { calls: [] }, error: null, attempts: 1 } as JobTask;
    const { result } = await deepCallAuditHandler.finalize(job({ date: "2026-09-24", timeZone: NY }), [done]);
    expect((result as { timeZone: string }).timeZone).toBe(NY);
  });
});
