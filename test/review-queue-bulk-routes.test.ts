import { describe, it, expect, vi, beforeEach } from "vitest";

// The bulk review forms of PATCH /api/admin/knowledge/relationships and
// PATCH /api/admin/knowledge/taxonomy ({ ids, action }), next to their
// unchanged single-id forms. The admin guard is mocked and the database is a
// small in-memory fake that applies eq/in filters, so org scoping and
// "one set update" are checked on the statements the routes actually send.

type Row = Record<string, unknown>;
interface Filter {
  op: "eq" | "in";
  col: string;
  val: unknown;
}
interface Stmt {
  table: string;
  kind: "select" | "update" | "insert";
  patch?: Row;
  rows?: Row[];
  filters: Filter[];
  cols?: string;
  single: boolean;
}
type DbError = { code?: string; message: string };

const m = vi.hoisted(() => {
  const state = {
    requireAdmin: vi.fn(),
    tables: {} as Record<string, Row[]>,
    stmts: [] as Stmt[],
    /** Force a statement to fail (return an error) instead of running it. */
    fail: null as null | ((s: Stmt) => DbError | null),
    execute(s: Stmt): { data: unknown; error: DbError | null } {
      const forced = state.fail?.(s);
      if (forced) return { data: null, error: forced };
      const table = (state.tables[s.table] ??= []);
      if (s.kind === "insert") {
        table.push(...(s.rows ?? []));
        return { data: null, error: null };
      }
      const hit = table.filter((r) =>
        s.filters.every((f) => (f.op === "eq" ? r[f.col] === f.val : (f.val as unknown[]).includes(r[f.col])))
      );
      if (s.kind === "update") {
        const patch = s.patch ?? {};
        // unique (source_object_id, relationship_type, target_object_id): the
        // whole statement fails, nothing is applied (as in Postgres).
        if (s.table === "knowledge_relationships" && "relationship_type" in patch) {
          const keys = new Set<string>();
          for (const r of table) {
            const next = hit.includes(r) ? { ...r, ...patch } : r;
            const key = `${next.source_object_id}|${next.relationship_type}|${next.target_object_id}`;
            if (keys.has(key)) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
            keys.add(key);
          }
        }
        for (const r of hit) Object.assign(r, patch);
      }
      const data = hit.map((r) => ({ ...r }));
      if (s.single) {
        return data.length === 1
          ? { data: data[0], error: null }
          : { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
      }
      return { data, error: null };
    },
  };
  return state;
});

vi.mock("@/lib/auth/admin", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/admin")>()),
  requireAdmin: m.requireAdmin,
}));
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const s: Stmt = { table, kind: "select", filters: [], single: false };
      const q = {
        select: (cols?: string) => {
          s.cols = cols;
          return q;
        },
        update: (patch: Row) => {
          s.kind = "update";
          s.patch = patch;
          return q;
        },
        insert: (rows: Row | Row[]) => {
          s.kind = "insert";
          s.rows = Array.isArray(rows) ? rows : [rows];
          return q;
        },
        eq: (col: string, val: unknown) => {
          s.filters.push({ op: "eq", col, val });
          return q;
        },
        in: (col: string, val: unknown[]) => {
          s.filters.push({ op: "in", col, val });
          return q;
        },
        single: () => {
          s.single = true;
          return q;
        },
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
          m.stmts.push(s);
          return Promise.resolve(m.execute(s)).then(res, rej);
        },
      };
      return q;
    },
  }),
}));

import { PATCH as patchRelationships } from "@/app/api/admin/knowledge/relationships/route";
import { PATCH as patchTaxonomy } from "@/app/api/admin/knowledge/taxonomy/route";
import { AdminAuthError } from "@/lib/auth/admin";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const ADMIN = { userId: "user-1", orgId: ORG, email: "admin@example.com", role: "admin", permissions: { documents: ["write"] }, memberId: "mem-1" };

/** A valid v4-shaped uuid per number. */
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function patch(handler: (req: Request) => Promise<Response>, url: string, body: unknown): Promise<Response> {
  return handler(
    new Request(`http://localhost${url}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}
const relationships = (body: unknown) => patch(patchRelationships, "/api/admin/knowledge/relationships", body);
const taxonomy = (body: unknown) => patch(patchTaxonomy, "/api/admin/knowledge/taxonomy", body);

const updates = (table: string) => m.stmts.filter((s) => s.table === table && s.kind === "update");
const inserts = (table: string) => m.stmts.filter((s) => s.table === table && s.kind === "insert");
const row = (table: string, id: string) => m.tables[table].find((r) => r.id === id);

function edge(n: number, org: string, source: string, type: string, target: string, status = "suggested"): Row {
  return { id: U(n), org_id: org, source_object_id: source, relationship_type: type, target_object_id: target, status };
}
function value(n: number, org: string, status = "proposed"): Row {
  return { id: U(n), org_id: org, kind: "subtype", domain: "sales", object_type: "framework", value: `v${n}`, status };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.stmts = [];
  m.fail = null;
  m.requireAdmin.mockResolvedValue(ADMIN);
  m.tables = {
    knowledge_relationships: [
      edge(1, ORG, "o1", "related_to", "o2"),
      edge(2, ORG, "o1", "related_to", "o3"),
      edge(3, ORG, "o2", "complements", "o3"),
      edge(4, ORG, "o1", "complements", "o2", "confirmed"),
      edge(9, OTHER_ORG, "x1", "related_to", "x2"),
    ],
    taxonomy_values: [value(1, ORG), value(2, ORG), value(3, ORG, "approved"), value(9, OTHER_ORG)],
    ingestion_decisions: [],
  };
});

// ---------------------------------------------------------------------------

describe("PATCH /api/admin/knowledge/relationships — bulk { ids, action }", () => {
  it("requires a signed-in admin holding documents:write", async () => {
    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Not authenticated", 401));
    expect((await relationships({ ids: [U(1)], action: "confirm" })).status).toBe(401);

    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Missing permission 'documents:write'", 403));
    const denied = await relationships({ ids: [U(1)], action: "confirm" });
    expect(denied.status).toBe(403);
    expect(m.requireAdmin).toHaveBeenLastCalledWith("documents:write");
    expect(m.stmts).toHaveLength(0);
    expect(row("knowledge_relationships", U(1))?.status).toBe("suggested");
  });

  it.each([
    ["an empty list", { ids: [], action: "confirm" }],
    ["a non-array", { ids: U(1), action: "confirm" }],
    ["a non-uuid id", { ids: [U(1), "1 or 1=1"], action: "confirm" }],
    ["more than 200 ids", { ids: Array.from({ length: 201 }, (_, i) => U(1000 + i)), action: "confirm" }],
    ["an unknown action", { ids: [U(1)], action: "delete" }],
  ])("rejects %s with 400 and touches nothing", async (_label, body) => {
    const res = await relationships(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toEqual(expect.any(String));
    expect(m.stmts).toHaveLength(0);
  });

  it("dedupes ids, so 200 distinct ids plus repeats is accepted", async () => {
    const ids = Array.from({ length: 200 }, (_, i) => U(1000 + i));
    const res = await relationships({ ids: [...ids, ...ids.slice(0, 50)], action: "reject" });
    expect(res.status).toBe(200);
    const [stmt] = updates("knowledge_relationships");
    expect(stmt.filters.find((f) => f.op === "in")?.val).toHaveLength(200);
  });

  it("confirms many in ONE org-scoped update and logs them in ONE batched insert", async () => {
    const res = await relationships({ ids: [U(1), U(2), U(9), U(404)], action: "confirm" });
    expect(res.status).toBe(200);
    const json = await res.json();
    // The other org's edge and the unknown id are not reported as updated.
    expect(json).toEqual({ ok: true, updated: 2, ids: [U(1), U(2)], failed: [] });

    const upd = updates("knowledge_relationships");
    expect(upd).toHaveLength(1);
    expect(upd[0].patch).toEqual({ status: "confirmed" });
    expect(upd[0].filters).toEqual(
      expect.arrayContaining([
        { op: "in", col: "id", val: [U(1), U(2), U(9), U(404)] },
        { op: "eq", col: "org_id", val: ORG },
      ])
    );
    expect(row("knowledge_relationships", U(1))?.status).toBe("confirmed");
    expect(row("knowledge_relationships", U(2))?.status).toBe("confirmed");
    expect(row("knowledge_relationships", U(9))?.status).toBe("suggested");

    const logs = inserts("ingestion_decisions");
    expect(logs).toHaveLength(1);
    expect(logs[0].rows).toEqual([
      expect.objectContaining({ org_id: ORG, object_id: "o1", stage: "relationships", decision: "user_confirm", input: { id: U(1), bulk: true }, output: { by: ADMIN.email } }),
      expect.objectContaining({ org_id: ORG, object_id: "o1", decision: "user_confirm", input: { id: U(2), bulk: true } }),
    ]);
  });

  it("rejects many (Reject / Remove) the same way", async () => {
    const json = await (await relationships({ ids: [U(3), U(4)], action: "reject" })).json();
    expect(json.ids).toEqual([U(3), U(4)]);
    expect(row("knowledge_relationships", U(3))?.status).toBe("rejected");
    expect(row("knowledge_relationships", U(4))?.status).toBe("rejected");
    expect(inserts("ingestion_decisions")[0].rows).toHaveLength(2);
  });

  it("confirms as a type for all; an unknown type is ignored", async () => {
    await relationships({ ids: [U(2), U(3)], action: "confirm", type: "contradicts" });
    expect(updates("knowledge_relationships")[0].patch).toEqual({ status: "confirmed", relationship_type: "contradicts" });
    expect(row("knowledge_relationships", U(2))?.relationship_type).toBe("contradicts");
    expect(inserts("ingestion_decisions")[0].rows?.[0]).toEqual(
      expect.objectContaining({ input: { id: U(2), type: "contradicts", bulk: true } })
    );

    m.stmts = [];
    await relationships({ ids: [U(1)], action: "confirm", type: "not_a_type" });
    expect(updates("knowledge_relationships")[0].patch).toEqual({ status: "confirmed" });
    expect(row("knowledge_relationships", U(1))?.relationship_type).toBe("related_to");
  });

  it("reports partial failure: a type collision fails only the colliding id", async () => {
    // U1 as "complements" would duplicate U4 (o1 complements o2); U2 is free.
    const res = await relationships({ ids: [U(1), U(2)], action: "confirm", type: "complements" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ids).toEqual([U(2)]);
    expect(json.updated).toBe(1);
    expect(json.failed).toEqual([{ id: U(1), error: expect.stringMatching(/already exists/) }]);

    // One failed set update, then one org-scoped update per id.
    const upd = updates("knowledge_relationships");
    expect(upd).toHaveLength(3);
    for (const s of upd) expect(s.filters).toContainEqual({ op: "eq", col: "org_id", val: ORG });
    expect(row("knowledge_relationships", U(1))).toEqual(expect.objectContaining({ status: "suggested", relationship_type: "related_to" }));
    expect(row("knowledge_relationships", U(2))).toEqual(expect.objectContaining({ status: "confirmed", relationship_type: "complements" }));
    expect(inserts("ingestion_decisions")[0].rows).toEqual([expect.objectContaining({ input: { id: U(2), type: "complements", bulk: true } })]);
  });

  it("fails the request on any other database error", async () => {
    m.fail = (s) => (s.kind === "update" ? { code: "XX000", message: "boom" } : null);
    const res = await relationships({ ids: [U(1)], action: "confirm" });
    expect(res.status).toBe(500);
    expect(inserts("ingestion_decisions")).toHaveLength(0);
  });

  it("keeps the single-id form unchanged", async () => {
    const res = await relationships({ id: U(1), action: "reject" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.edge).toEqual(expect.objectContaining({ id: U(1), status: "rejected" }));
    expect(updates("knowledge_relationships")[0].filters).toEqual([
      { op: "eq", col: "id", val: U(1) },
      { op: "eq", col: "org_id", val: ORG },
    ]);
    expect(inserts("ingestion_decisions")[0].rows?.[0]).toEqual(expect.objectContaining({ object_id: "o1", decision: "user_reject" }));

    // Another org's edge is not found through the single form either.
    expect((await relationships({ id: U(9), action: "confirm" })).status).toBe(500);
    expect(row("knowledge_relationships", U(9))?.status).toBe("suggested");
    // Malformed ids and unknown actions are refused before any query.
    m.stmts = [];
    expect((await relationships({ id: "not-a-uuid", action: "confirm" })).status).toBe(400);
    expect((await relationships({ id: U(1), action: "archive" })).status).toBe(400);
    expect(m.stmts).toHaveLength(0);
  });

  it("answers a single-id type collision with 409 instead of a raw database error", async () => {
    const res = await relationships({ id: U(1), action: "confirm", type: "complements" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already exists/);
  });
});

// ---------------------------------------------------------------------------

describe("PATCH /api/admin/knowledge/taxonomy — bulk { ids, action }", () => {
  it("requires a signed-in admin holding documents:write", async () => {
    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Not authenticated", 401));
    expect((await taxonomy({ ids: [U(1)], action: "approve" })).status).toBe(401);

    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Missing permission 'documents:write'", 403));
    expect((await taxonomy({ ids: [U(1)], action: "approve" })).status).toBe(403);
    expect(m.requireAdmin).toHaveBeenLastCalledWith("documents:write");
    expect(m.stmts).toHaveLength(0);
  });

  it.each([
    ["rename (one value at a time)", { ids: [U(1)], action: "rename", value: "x" }],
    ["an empty list", { ids: [], action: "approve" }],
    ["a non-uuid id", { ids: ["abc"], action: "approve" }],
    ["more than 200 ids", { ids: Array.from({ length: 201 }, (_, i) => U(1000 + i)), action: "reject" }],
  ])("rejects %s with 400 and touches nothing", async (_label, body) => {
    const res = await taxonomy(body);
    expect(res.status).toBe(400);
    expect(m.stmts).toHaveLength(0);
  });

  it("approves many in ONE org-scoped update", async () => {
    const res = await taxonomy({ ids: [U(1), U(2), U(9), U(404)], action: "approve" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, updated: 2, ids: [U(1), U(2)] });

    const upd = updates("taxonomy_values");
    expect(upd).toHaveLength(1);
    expect(upd[0].patch).toEqual({ status: "approved" });
    expect(upd[0].filters).toEqual(
      expect.arrayContaining([
        { op: "in", col: "id", val: [U(1), U(2), U(9), U(404)] },
        { op: "eq", col: "org_id", val: ORG },
      ])
    );
    expect(row("taxonomy_values", U(1))?.status).toBe("approved");
    expect(row("taxonomy_values", U(9))?.status).toBe("proposed");
  });

  it("rejects / retires many", async () => {
    const json = await (await taxonomy({ ids: [U(2), U(3)], action: "reject" })).json();
    expect(json.ids).toEqual([U(2), U(3)]);
    expect(row("taxonomy_values", U(2))?.status).toBe("rejected");
    expect(row("taxonomy_values", U(3))?.status).toBe("rejected");
  });

  it("fails the request on a database error", async () => {
    m.fail = (s) => (s.kind === "update" ? { code: "XX000", message: "boom" } : null);
    expect((await taxonomy({ ids: [U(1)], action: "approve" })).status).toBe(500);
    expect(row("taxonomy_values", U(1))?.status).toBe("proposed");
  });

  it("keeps the single-id form unchanged", async () => {
    const res = await taxonomy({ id: U(1), action: "approve" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, value: expect.objectContaining({ id: U(1), status: "approved" }) });
    expect(updates("taxonomy_values")[0].filters).toEqual([
      { op: "eq", col: "id", val: U(1) },
      { op: "eq", col: "org_id", val: ORG },
    ]);
    m.stmts = [];
    expect((await taxonomy({ id: "nope", action: "approve" })).status).toBe(400);
    expect(m.stmts).toHaveLength(0);
  });
});
