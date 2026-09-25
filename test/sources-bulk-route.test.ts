import { describe, it, expect, vi, beforeEach } from "vitest";

// Bulk pause / resume: PATCH /api/admin/sources { ids, is_active }. The admin
// session is mocked, and the DB is a tiny in-memory data_sources table that
// really applies the `in` / `eq` filters, so org scoping is checked against
// rows (a source in another org must never change), not just the call shape.
type Row = { id: string; org_id: string; name: string; is_active: boolean; updated_at: string | null };
type Filter = [op: "eq" | "in", col: string, val: unknown];
interface Call {
  table: string;
  op: "select" | "update";
  payload?: Record<string, unknown>;
  filters: Filter[];
}

const m = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  isDemo: vi.fn(() => false),
  rows: [] as Row[],
  calls: [] as Call[],
  failWith: null as { message: string } | null,
}));

vi.mock("@/lib/auth/admin", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/admin")>()),
  requireAdmin: m.requireAdmin,
}));
vi.mock("@/lib/demo/mode", () => ({ isDemo: m.isDemo }));
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] };
      // uuid columns compare case-insensitively in Postgres.
      const norm = (x: unknown) => (typeof x === "string" ? x.toLowerCase() : x);
      const matches = (r: Row) =>
        call.filters.every(([op, col, val]) => {
          const v = norm((r as unknown as Record<string, unknown>)[col]);
          return op === "eq" ? v === norm(val) : Array.isArray(val) && val.map(norm).includes(v);
        });
      const exec = () => {
        m.calls.push(call);
        if (m.failWith) return Promise.resolve({ data: null, error: m.failWith });
        const hit = m.rows.filter(matches);
        if (call.op === "update") for (const r of hit) Object.assign(r, call.payload);
        return Promise.resolve({ data: hit.map((r) => ({ id: r.id, is_active: r.is_active })), error: null });
      };
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        update: (p: Record<string, unknown>) => ((call.op = "update"), (call.payload = p), q),
        eq: (col: string, val: unknown) => (call.filters.push(["eq", col, val]), q),
        in: (col: string, val: unknown) => (call.filters.push(["in", col, val]), q),
        order: () => q,
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => exec().then(res, rej),
      });
      return q;
    },
  }),
}));

import { PATCH } from "@/app/api/admin/sources/route";
import { AdminAuthError } from "@/lib/auth/admin";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "aaaaaaaa-0000-4000-8000-000000000002";
const FOREIGN = "bbbbbbbb-0000-4000-8000-000000000003";
const GHOST = "cccccccc-0000-4000-8000-000000000004";

function patch(body: unknown): Request {
  return new Request("http://localhost/api/admin/sources", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const row = (id: string) => m.rows.find((r) => r.id === id)!;
const updates = () => m.calls.filter((c) => c.op === "update");

beforeEach(() => {
  vi.clearAllMocks();
  m.isDemo.mockReturnValue(false);
  m.failWith = null;
  m.calls = [];
  m.rows = [
    { id: A, org_id: ORG, name: "Call scoring", is_active: true, updated_at: null },
    { id: B, org_id: ORG, name: "Coaching", is_active: true, updated_at: null },
    { id: FOREIGN, org_id: OTHER_ORG, name: "Someone else's", is_active: true, updated_at: null },
  ];
  m.requireAdmin.mockResolvedValue({ orgId: ORG, memberId: "member-1", role: "admin", permissions: {} });
});

describe("PATCH /api/admin/sources — auth", () => {
  it("returns 401 when not signed in, without touching the DB", async () => {
    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Not authenticated", 401));
    const res = await PATCH(patch({ ids: [A], is_active: false }));
    expect(res.status).toBe(401);
    expect(m.calls).toHaveLength(0);
    expect(row(A).is_active).toBe(true);
  });

  it("requires data_sources:write (403 without it)", async () => {
    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Missing permission 'data_sources:write'", 403));
    const res = await PATCH(patch({ ids: [A], is_active: false }));
    expect(res.status).toBe(403);
    expect(m.requireAdmin).toHaveBeenCalledWith("data_sources:write");
    expect(m.calls).toHaveLength(0);
  });
});

describe("PATCH /api/admin/sources — validation", () => {
  it.each([
    ["invalid JSON", "{nope"],
    ["a JSON array body", "[1,2]"],
    ["missing ids", { is_active: false }],
    ["empty ids", { ids: [], is_active: false }],
    ["ids not an array", { ids: A, is_active: false }],
    ["a non-uuid id", { ids: [A, "src-1"], is_active: false }],
    ["a filter-injection id", { ids: [`${A},id.neq.0`], is_active: false }],
    ["a non-string id", { ids: [A, 42], is_active: false }],
    ["is_active missing", { ids: [A] }],
    ["is_active as a string", { ids: [A], is_active: "false" }],
  ])("400 for %s", async (_label, body) => {
    const res = await PATCH(patch(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
    expect(updates()).toHaveLength(0);
  });

  it("400 for more than 200 unique ids", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const res = await PATCH(patch({ ids, is_active: false }));
    expect(res.status).toBe(400);
    expect(updates()).toHaveLength(0);
  });

  it("accepts 200 ids after dedupe (duplicates don't count against the cap)", async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const res = await PATCH(patch({ ids: [...ids, ...ids.slice(0, 50)], is_active: false }));
    expect(res.status).toBe(200);
    const [call] = updates();
    expect((call.filters.find(([op]) => op === "in")![2] as string[]).length).toBe(200);
  });

  it("accepts the demo store's short ids only in demo mode", async () => {
    m.rows.push({ id: "src-1", org_id: ORG, name: "Demo", is_active: true, updated_at: null });
    expect((await PATCH(patch({ ids: ["src-1"], is_active: false }))).status).toBe(400);
    m.isDemo.mockReturnValue(true);
    const res = await PATCH(patch({ ids: ["src-1"], is_active: false }));
    expect(res.status).toBe(200);
    expect(row("src-1").is_active).toBe(false);
  });
});

describe("PATCH /api/admin/sources — bulk pause / resume", () => {
  it("pauses every listed source in ONE org-scoped update", async () => {
    const res = await PATCH(patch({ ids: [A, B], is_active: false }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ids: [A, B], failed: [], is_active: false });

    expect(updates()).toHaveLength(1);
    const [call] = updates();
    expect(call.table).toBe("data_sources");
    expect(call.payload).toMatchObject({ is_active: false });
    expect(typeof call.payload?.updated_at).toBe("string");
    expect(call.filters).toContainEqual(["in", "id", [A, B]]);
    expect(call.filters).toContainEqual(["eq", "org_id", ORG]);
    expect(row(A).is_active).toBe(false);
    expect(row(B).is_active).toBe(false);
  });

  it("resumes sources", async () => {
    row(A).is_active = false;
    const res = await PATCH(patch({ ids: [A], is_active: true }));
    expect(await res.json()).toMatchObject({ ids: [A], failed: [], is_active: true });
    expect(row(A).is_active).toBe(true);
  });

  it("never touches another org's source, and reports it (and unknown ids) as failed", async () => {
    const res = await PATCH(patch({ ids: [A, FOREIGN, GHOST], is_active: false }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ids).toEqual([A]);
    expect(json.failed).toEqual([
      { id: FOREIGN, error: "Data source not found" },
      { id: GHOST, error: "Data source not found" },
    ]);
    expect(row(FOREIGN).is_active).toBe(true);
    expect(row(FOREIGN).updated_at).toBeNull();
  });

  it("scopes to the session's org even when the body names another", async () => {
    const res = await PATCH(patch({ ids: [FOREIGN], is_active: false, org_id: OTHER_ORG }));
    const json = await res.json();
    expect(json.ids).toEqual([]);
    expect(json.failed).toHaveLength(1);
    expect(updates()[0].filters).toContainEqual(["eq", "org_id", ORG]);
    expect(row(FOREIGN).is_active).toBe(true);
  });

  it("dedupes ids case-insensitively and answers in the caller's spelling", async () => {
    const upper = A.toUpperCase();
    const res = await PATCH(patch({ ids: [upper, A, upper], is_active: false }));
    const json = await res.json();
    expect(updates()[0].filters).toContainEqual(["in", "id", [upper]]);
    expect(json.ids).toEqual([upper]);
    expect(json.failed).toEqual([]);
    expect(row(A).is_active).toBe(false);
  });

  it("returns 500 with the DB error", async () => {
    m.failWith = { message: "connection reset" };
    const res = await PATCH(patch({ ids: [A], is_active: false }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("connection reset");
  });
});
