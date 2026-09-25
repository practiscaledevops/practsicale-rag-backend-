import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Bulk forms of /api/admin/knowledge/learning:
//   PATCH { ids, action | lifecycleStatus }  — set-based, org-scoped record updates
//   POST  { action, edgeIds }                — follow-ups attached / ignored one by one
// Auth, the DB (a tiny in-memory PostgREST fake) and the follow-up helpers are
// mocked; nothing touches the network.

type Row = Record<string, unknown>;
type Filter = ["eq" | "in", string, unknown];
interface Query {
  table: string;
  op: "select" | "update";
  payload?: Row;
  filters: Filter[];
  returning: boolean;
}
type DbError = { message: string; code?: string };

const m = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  loadFollowupContext: vi.fn(),
  attachEvidence: vi.fn(),
  ignoreFollowup: vi.fn(),
  tables: {} as Record<string, Record<string, unknown>[]>,
  log: [] as unknown[],
  fail: null as null | ((q: unknown) => { message: string; code?: string } | null),
}));

vi.mock("@/lib/auth/admin", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/admin")>()),
  requireAdmin: m.requireAdmin,
}));
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => ({ from: (table: string) => builder(table) }) }));
vi.mock("@/lib/learning-followup", () => ({
  listFollowupQueue: vi.fn(async () => []),
  loadFollowupContext: m.loadFollowupContext,
  attachEvidence: m.attachEvidence,
  ignoreFollowup: m.ignoreFollowup,
  computeResultFromEvidence: vi.fn(),
  resultRecordMarkdown: vi.fn(),
  metricsAfterObject: vi.fn(),
}));
vi.mock("@/lib/knowledge-compiler", () => ({ compileKnowledge: vi.fn() }));
vi.mock("@/lib/settings", () => ({ loadSettings: vi.fn() }));

import { PATCH, POST } from "@/app/api/admin/knowledge/learning/route";
import { AdminAuthError } from "@/lib/auth/admin";

/** Minimal chainable PostgREST stand-in: eq / in filters over in-memory rows, update mutates them. */
function builder(table: string) {
  const q: Query = { table, op: "select", filters: [], returning: false };
  const matches = (r: Row) => q.filters.every(([kind, col, v]) => (kind === "eq" ? r[col] === v : (v as unknown[]).includes(r[col])));
  const exec = (): { data: Row[] | null; error: DbError | null } => {
    m.log.push(q);
    const error = m.fail?.(q) ?? null;
    if (error) return { data: null, error };
    const rows = (m.tables[table] ?? []).filter(matches);
    if (q.op === "update") {
      for (const r of rows) Object.assign(r, q.payload);
      return { data: q.returning ? rows.map((r) => ({ ...r })) : null, error: null };
    }
    return { data: rows.map((r) => ({ ...r })), error: null };
  };
  const b = {
    select: () => {
      if (q.op === "update") q.returning = true;
      return b;
    },
    update: (payload: Row) => {
      q.op = "update";
      q.payload = payload;
      return b;
    },
    eq: (col: string, v: unknown) => {
      q.filters.push(["eq", col, v]);
      return b;
    },
    in: (col: string, v: unknown[]) => {
      q.filters.push(["in", col, v]);
      return b;
    },
    order: () => b,
    limit: () => b,
    maybeSingle: async () => {
      const r = exec();
      return { data: r.data?.[0] ?? null, error: r.error };
    },
    single: async () => {
      const r = exec();
      return { data: r.data?.[0] ?? null, error: r.error ?? (r.data?.length ? null : { message: "no rows" }) };
    },
    then: <T>(res: (v: { data: Row[] | null; error: DbError | null }) => T, rej?: (e: unknown) => T) => Promise.resolve(exec()).then(res, rej),
  };
  return b;
}

const ORG = "org-1";
const OTHER_ORG = "org-2";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const R1 = id(1);
const R2 = id(2);
const R_OTHER = id(3);
const O1 = id(11);
const O2 = id(12);
const O_OTHER = id(13);

const queries = () => m.log as Query[];

function req(method: "PATCH" | "POST", body: unknown): Request {
  return new Request("http://localhost/api/admin/knowledge/learning", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function seed() {
  m.tables = {
    learning_records: [
      { id: R1, org_id: ORG, object_id: O1, lifecycle_status: "open", related_playbook_refs: [] },
      { id: R2, org_id: ORG, object_id: O2, lifecycle_status: "measuring", related_playbook_refs: [] },
      { id: R_OTHER, org_id: OTHER_ORG, object_id: O_OTHER, lifecycle_status: "open", related_playbook_refs: [] },
    ],
    knowledge_objects: [
      { id: O1, org_id: ORG, ref: "EXP-001", name: "One", internal_validation: "unvalidated" },
      { id: O2, org_id: ORG, ref: "EXP-002", name: "Two", internal_validation: "unvalidated" },
      { id: O_OTHER, org_id: OTHER_ORG, ref: "EXP-001", name: "Theirs", internal_validation: "unvalidated" },
    ],
  };
}
const rec = (rid: string) => m.tables.learning_records.find((r) => r.id === rid)!;
const obj = (oid: string) => m.tables.knowledge_objects.find((o) => o.id === oid)!;

/** A follow-up context as loadFollowupContext returns it. */
function ctx(edgeId: string, status = "suggested") {
  return {
    edge: { id: edgeId, source_object_id: O2, target_object_id: O1, status, note: null },
    record: { id: R1, object_id: O1, lifecycle_status: "implementing", evidence_document_ids: [] },
    recordObject: { id: O1, ref: "EXP-001" },
    evidence: { id: O2, ref: "REP-001", document_id: "doc-1" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.log = [];
  m.fail = null;
  seed();
  m.requireAdmin.mockResolvedValue({ orgId: ORG, userId: "user-1", email: "admin@example.com", role: "admin", permissions: {}, memberId: "mem-1" });
  m.attachEvidence.mockResolvedValue({ id: R1 });
  m.ignoreFollowup.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PATCH /api/admin/knowledge/learning — bulk", () => {
  it("401s without an admin session and touches nothing", async () => {
    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Not authenticated", 401));
    const res = await PATCH(req("PATCH", { ids: [R1], action: "validate" }));
    expect(res.status).toBe(401);
    expect(queries()).toHaveLength(0);
  });

  it("requires documents:write (403 otherwise)", async () => {
    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Missing permission 'documents:write'", 403));
    const res = await PATCH(req("PATCH", { ids: [R1], action: "validate" }));
    expect(res.status).toBe(403);
    expect(m.requireAdmin).toHaveBeenCalledWith("documents:write");
    expect(queries()).toHaveLength(0);
  });

  it.each([
    ["an empty list", { ids: [], action: "validate" }],
    ["a non-array", { ids: R1, action: "validate" }],
    ["a non-uuid id", { ids: [R1, "not-a-uuid"], action: "validate" }],
    ["more than 200 ids", { ids: Array.from({ length: 201 }, (_, i) => id(1000 + i)), action: "validate" }],
    ["no action or status", { ids: [R1] }],
    ["an unknown status", { ids: [R1], lifecycleStatus: "done-ish" }],
    ["promote_standard (single only)", { ids: [R1], action: "promote_standard" }],
  ])("400s for %s", async (_label, body) => {
    const res = await PATCH(req("PATCH", body));
    expect(res.status).toBe(400);
    expect(queries()).toHaveLength(0);
  });

  it("dedupes ids before the 200 limit", async () => {
    const res = await PATCH(req("PATCH", { ids: Array.from({ length: 250 }, () => R1), action: "validate" }));
    expect(res.status).toBe(200);
    expect((await res.json()).ids).toEqual([R1]);
  });

  it("validates many records and their objects, only inside the admin's org", async () => {
    const res = await PATCH(req("PATCH", { ids: [R1, R2, R_OTHER], action: "validate" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, updated: 2, lifecycleStatus: "validated", missing: [R_OTHER] });
    expect([...json.ids].sort()).toEqual([R1, R2]);

    expect(rec(R1).lifecycle_status).toBe("validated");
    expect(rec(R2).lifecycle_status).toBe("validated");
    expect(obj(O1).internal_validation).toBe("validated");
    expect(obj(O2).internal_validation).toBe("validated");
    // The other org's record and object are untouched.
    expect(rec(R_OTHER).lifecycle_status).toBe("open");
    expect(obj(O_OTHER).internal_validation).toBe("unvalidated");

    // Set-based: one read, one objects update, one records update — each org-scoped.
    expect(queries().map((q) => `${q.table}:${q.op}`)).toEqual([
      "learning_records:select",
      "knowledge_objects:update",
      "learning_records:update",
    ]);
    for (const q of queries()) expect(q.filters).toContainEqual(["eq", "org_id", ORG]);
  });

  it("rejects many records (records rejected, objects' internal validation rejected)", async () => {
    const res = await PATCH(req("PATCH", { ids: [R1, R2], action: "reject" }));
    expect(res.status).toBe(200);
    expect(rec(R1).lifecycle_status).toBe("rejected");
    expect(obj(O2).internal_validation).toBe("rejected");
  });

  it("sets a lifecycle status (e.g. archived) without touching the objects", async () => {
    const res = await PATCH(req("PATCH", { ids: [R1, R2], lifecycleStatus: "archived" }));
    expect(res.status).toBe(200);
    expect((await res.json()).updated).toBe(2);
    expect(rec(R1).lifecycle_status).toBe("archived");
    expect(rec(R2).lifecycle_status).toBe("archived");
    expect(obj(O1).internal_validation).toBe("unvalidated");
    expect(queries().some((q) => q.table === "knowledge_objects")).toBe(false);
  });

  it("reports every id missing when none belong to the org, without writing", async () => {
    const res = await PATCH(req("PATCH", { ids: [R_OTHER], action: "validate" }));
    expect(await res.json()).toMatchObject({ ok: true, updated: 0, ids: [], missing: [R_OTHER] });
    expect(queries().every((q) => q.op === "select")).toBe(true);
  });

  it("500s when the update fails", async () => {
    m.fail = (q) => ((q as Query).op === "update" && (q as Query).table === "learning_records" ? { message: "boom" } : null);
    const res = await PATCH(req("PATCH", { ids: [R1], lifecycleStatus: "completed" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("boom");
  });

  it("keeps the single-record form working", async () => {
    const res = await PATCH(req("PATCH", { id: R1, action: "validate" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.record.lifecycle_status).toBe("validated");
    expect(obj(O1).internal_validation).toBe("validated");
    expect(rec(R2).lifecycle_status).toBe("measuring");
  });
});

describe("POST /api/admin/knowledge/learning — bulk follow-ups", () => {
  const E1 = id(21);
  const E2 = id(22);
  const E3 = id(23);
  const E4 = id(24);

  it("401s without an admin session", async () => {
    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Not authenticated", 401));
    const res = await POST(req("POST", { action: "attach_evidence", edgeIds: [E1] }));
    expect(res.status).toBe(401);
    expect(m.loadFollowupContext).not.toHaveBeenCalled();
  });

  it.each([
    ["compute_result (single only)", { action: "compute_result", edgeIds: [E1] }],
    ["an unknown action", { action: "explode", edgeIds: [E1] }],
    ["an empty list", { action: "ignore", edgeIds: [] }],
    ["a non-uuid id", { action: "ignore", edgeIds: ["nope"] }],
    ["more than 100 ids", { action: "ignore", edgeIds: Array.from({ length: 101 }, (_, i) => id(2000 + i)) }],
  ])("400s for %s", async (_label, body) => {
    const res = await POST(req("POST", body));
    expect(res.status).toBe(400);
    expect(m.loadFollowupContext).not.toHaveBeenCalled();
  });

  it("attaches one edge at a time and reports per-edge failures without stopping", async () => {
    m.loadFollowupContext.mockImplementation(async (_db: unknown, _org: string, edgeId: string) => {
      if (edgeId === E2) return null; // not in this org / gone
      if (edgeId === E3) return ctx(edgeId, "rejected");
      return ctx(edgeId);
    });
    let inFlight = 0;
    let maxInFlight = 0;
    m.attachEvidence.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return { id: R1 };
    });

    const res = await POST(req("POST", { action: "attach_evidence", edgeIds: [E1, E2, E3, E4] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.done).toEqual([E1, E4]);
    expect(json.failed).toEqual([
      { edgeId: E2, error: "Not found", status: 404 },
      { edgeId: E3, error: "This suggestion was ignored earlier.", status: 409 },
    ]);
    expect(json.remaining).toEqual([]);
    // Sequential (read-modify-write of the record's evidence list), in request order, org-scoped.
    expect(maxInFlight).toBe(1);
    expect(m.attachEvidence.mock.calls.map((c) => (c[2] as { edge: { id: string } }).edge.id)).toEqual([E1, E4]);
    for (const c of m.attachEvidence.mock.calls) {
      expect(c[1]).toBe(ORG);
      expect(c[3]).toBe("admin@example.com");
    }
    for (const c of m.loadFollowupContext.mock.calls) expect(c[1]).toBe(ORG);
  });

  it("ignores only live suggestions (409 for reviewed ones) and keeps going after an error", async () => {
    m.loadFollowupContext.mockImplementation(async (_db: unknown, _org: string, edgeId: string) => ctx(edgeId, edgeId === E2 ? "confirmed" : "suggested"));
    m.ignoreFollowup.mockImplementation(async (_db: unknown, _org: string, c: { edge: { id: string } }) => {
      if (c.edge.id === E3) throw { message: "write failed" };
    });
    const json = await (await POST(req("POST", { action: "ignore", edgeIds: [E1, E2, E3, E4] }))).json();
    expect(json.done).toEqual([E1, E4]);
    expect(json.failed).toEqual([
      { edgeId: E2, error: "This suggestion was already reviewed.", status: 409 },
      { edgeId: E3, error: "write failed", status: 500 },
    ]);
    expect(m.ignoreFollowup).toHaveBeenCalledTimes(3);
    expect(m.attachEvidence).not.toHaveBeenCalled();
  });

  it("stops at the time budget and returns the rest as remaining (always making progress)", async () => {
    m.loadFollowupContext.mockImplementation(async (_db: unknown, _org: string, edgeId: string) => ctx(edgeId));
    let now = 0;
    // Each Date.now() call moves the clock 30s: start, then one check before every edge after the first.
    vi.spyOn(Date, "now").mockImplementation(() => (now += 30_000));
    const json = await (await POST(req("POST", { action: "attach_evidence", edgeIds: [E1, E2, E3, E4] }))).json();
    expect(json.done).toEqual([E1, E2]);
    expect(json.failed).toEqual([]);
    expect(json.remaining).toEqual([E3, E4]);
  });

  it("answers 503 (migration hint) when the tables are missing", async () => {
    m.loadFollowupContext.mockRejectedValue({ code: "42P01", message: 'relation "knowledge_relationships" does not exist' });
    const res = await POST(req("POST", { action: "ignore", edgeIds: [E1, E2] }));
    expect(res.status).toBe(503);
  });

  it("keeps the single follow-up form working", async () => {
    m.loadFollowupContext.mockResolvedValue(ctx(E1));
    const res = await POST(req("POST", { action: "ignore", edgeId: E1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.loadFollowupContext).toHaveBeenCalledTimes(1);
    expect(m.ignoreFollowup).toHaveBeenCalledTimes(1);
  });
});
