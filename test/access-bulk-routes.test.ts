import { describe, it, expect, vi, beforeEach } from "vitest";

// Bulk forms of the access admin routes: DELETE /api/admin/keys { ids } (revoke
// many), POST /api/admin/connectors { action: "grant", api_key_ids } (grant one
// connector to many keys) and DELETE /api/admin/connectors { grant_ids } (remove
// many grants). The admin session and the DB are mocked: every query is recorded
// (table, operation, filters) so the tests can assert org scoping.
type Filter = [op: string, col: string, val: unknown];
interface Call {
  table: string;
  op: "select" | "insert" | "update" | "delete" | "upsert";
  payload?: unknown;
  options?: unknown;
  filters: Filter[];
}
type Result = { data: unknown; error: { message: string; code?: string } | null };

const m = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  calls: [] as Call[],
  respond: vi.fn<(call: Call) => Result | undefined>(),
}));

vi.mock("@/lib/auth/admin", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/admin")>()),
  requireAdmin: m.requireAdmin,
}));
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] };
      const exec = (): Promise<Result> => {
        m.calls.push(call);
        return Promise.resolve(m.respond(call) ?? { data: null, error: null });
      };
      const q: Record<string, unknown> = {};
      const filter = (op: string) => (col: string, val: unknown) => {
        call.filters.push([op, col, val]);
        return q;
      };
      Object.assign(q, {
        select: () => q,
        insert: (p: unknown) => ((call.op = "insert"), (call.payload = p), q),
        update: (p: unknown) => ((call.op = "update"), (call.payload = p), q),
        upsert: (p: unknown, o: unknown) => ((call.op = "upsert"), (call.payload = p), (call.options = o), q),
        delete: () => ((call.op = "delete"), q),
        eq: filter("eq"),
        in: filter("in"),
        is: filter("is"),
        order: () => q,
        single: exec,
        maybeSingle: exec,
        then: (res: (v: Result) => unknown, rej: (e: unknown) => unknown) => exec().then(res, rej),
      });
      return q;
    },
  }),
}));

import { DELETE as keysDelete } from "@/app/api/admin/keys/route";
import { POST as connectorsPost, DELETE as connectorsDelete } from "@/app/api/admin/connectors/route";
import { AdminAuthError } from "@/lib/auth/admin";

const ORG = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CONNECTOR = "22222222-2222-4222-8222-222222222222";

function req(url: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}
const callsTo = (table: string, op?: Call["op"]) =>
  m.calls.filter((c) => c.table === table && (op === undefined || c.op === op));
const hasFilter = (c: Call, op: string, col: string, val?: unknown) =>
  c.filters.some(([o, k, v]) => o === op && k === col && (val === undefined || JSON.stringify(v) === JSON.stringify(val)));

beforeEach(() => {
  vi.clearAllMocks();
  m.calls.length = 0;
  m.requireAdmin.mockResolvedValue({ orgId: ORG, memberId: "member-1", role: "admin", permissions: {} });
  m.respond.mockImplementation(() => undefined);
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/keys
// ---------------------------------------------------------------------------

describe("DELETE /api/admin/keys — bulk revoke", () => {
  it("requires a signed-in admin holding api_keys:revoke", async () => {
    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Not authenticated", 401));
    expect((await keysDelete(req("/api/admin/keys", "DELETE", { ids: [id(1)] }))).status).toBe(401);

    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Missing permission 'api_keys:revoke'", 403));
    expect((await keysDelete(req("/api/admin/keys", "DELETE", { ids: [id(1)] }))).status).toBe(403);
    expect(m.requireAdmin).toHaveBeenLastCalledWith("api_keys:revoke");
    expect(m.calls).toEqual([]);
  });

  it.each([
    ["no body", undefined, "A key id is required"],
    ["a non-JSON body", "not json", "A key id is required"],
    ["a body without ids", { id: id(1) }, "A key id is required"],
    ["an empty list", { ids: [] }, "ids must be a non-empty array of ids"],
    ["a non-array", { ids: id(1) }, "ids must be a non-empty array of ids"],
    ["a non-uuid id", { ids: [id(1), "1 or 1=1"] }, "ids must be UUIDs"],
    ["a non-string id", { ids: [id(1), 7] }, "ids must be UUIDs"],
    ["more than 200 ids", { ids: Array.from({ length: 201 }, (_, i) => id(i + 1)) }, "At most 200 ids per request"],
  ])("400s on %s", async (_label, body, error) => {
    const res = await keysDelete(req("/api/admin/keys", "DELETE", body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(error);
    expect(m.calls).toEqual([]);
  });

  it("revokes in ONE org-scoped update and reports keys it could not revoke", async () => {
    // id(2) is another org's key or already revoked: the update does not return it.
    m.respond.mockImplementation((c) =>
      c.table === "api_keys" && c.op === "update" ? { data: [{ id: id(1) }, { id: id(3) }], error: null } : undefined
    );
    const res = await keysDelete(req("/api/admin/keys", "DELETE", { ids: [id(1), id(2), id(3), id(1)] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.revoked).toEqual([id(1), id(3)]);
    expect(json.failed).toEqual([{ id: id(2), error: "Key not found or already revoked" }]);
    expect(typeof json.revoked_at).toBe("string");

    const updates = callsTo("api_keys", "update");
    expect(updates).toHaveLength(1);
    const [u] = updates;
    expect(u.payload).toEqual({ revoked_at: json.revoked_at });
    expect(hasFilter(u, "in", "id", [id(1), id(2), id(3)])).toBe(true); // deduped
    expect(hasFilter(u, "eq", "org_id", ORG)).toBe(true);
    expect(hasFilter(u, "is", "revoked_at", null)).toBe(true);
  });

  it("ignores an org_id in the body (org comes from the session)", async () => {
    await keysDelete(req("/api/admin/keys", "DELETE", { ids: [id(1)], org_id: "33333333-3333-4333-8333-333333333333" }));
    const [u] = callsTo("api_keys", "update");
    expect(u.filters.filter(([, col]) => col === "org_id")).toEqual([["eq", "org_id", ORG]]);
  });

  it("matches ids case-insensitively and answers in the caller's spelling", async () => {
    const stored = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const upper = stored.toUpperCase();
    m.respond.mockImplementation((c) => (c.op === "update" ? { data: [{ id: stored }], error: null } : undefined));
    const json = await (await keysDelete(req("/api/admin/keys", "DELETE", { ids: [upper] }))).json();
    expect(json.revoked).toEqual([upper]);
    expect(json.failed).toEqual([]);
  });

  it("500s when the update fails", async () => {
    m.respond.mockImplementation((c) => (c.op === "update" ? { data: null, error: { message: "boom" } } : undefined));
    const res = await keysDelete(req("/api/admin/keys", "DELETE", { ids: [id(1)] }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("boom");
  });

  it("keeps the single ?id= contract", async () => {
    m.respond.mockImplementation((c) => (c.op === "update" ? { data: { id: id(5) }, error: null } : undefined));
    const ok = await keysDelete(req(`/api/admin/keys?id=${id(5)}`, "DELETE"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: id(5), revoked: true });
    const [u] = callsTo("api_keys", "update");
    expect(hasFilter(u, "eq", "id", id(5))).toBe(true);
    expect(hasFilter(u, "eq", "org_id", ORG)).toBe(true);

    m.respond.mockImplementation(() => ({ data: null, error: null }));
    const missing = await keysDelete(req(`/api/admin/keys?id=${id(6)}`, "DELETE"));
    expect(missing.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/connectors { action: "grant", api_key_ids }
// ---------------------------------------------------------------------------

describe("POST /api/admin/connectors — grant to many keys", () => {
  const grantBody = (ids: unknown, extra: Record<string, unknown> = {}) => ({
    action: "grant",
    connector_id: CONNECTOR,
    api_key_ids: ids,
    ...extra,
  });

  it("requires connectors:write", async () => {
    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Missing permission 'connectors:write'", 403));
    const res = await connectorsPost(req("/api/admin/connectors", "POST", grantBody([id(1)])));
    expect(res.status).toBe(403);
    expect(m.requireAdmin).toHaveBeenLastCalledWith("connectors:write");
    expect(m.calls).toEqual([]);
  });

  it.each([
    ["no connector", { action: "grant", api_key_ids: [id(1)] }, "connector_id is required"],
    ["a non-uuid connector", grantBody([id(1)], { connector_id: "x,y" }), "connector_id must be a UUID"],
    ["an empty list", grantBody([]), "api_key_ids must be a non-empty array of ids"],
    ["a non-uuid key id", grantBody(["key; drop"]), "api_key_ids must be UUIDs"],
    ["more than 50 keys", grantBody(Array.from({ length: 51 }, (_, i) => id(i + 1))), "At most 50 api_key_ids per request"],
  ])("400s on %s", async (_label, body, error) => {
    const res = await connectorsPost(req("/api/admin/connectors", "POST", body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(error);
    expect(m.calls).toEqual([]);
  });

  it("404s when the connector is not in this org", async () => {
    m.respond.mockImplementation((c) => (c.table === "connectors" ? { data: null, error: null } : { data: [], error: null }));
    const res = await connectorsPost(req("/api/admin/connectors", "POST", grantBody([id(1)])));
    expect(res.status).toBe(404);
    const [conn] = callsTo("connectors");
    expect(hasFilter(conn, "eq", "id", CONNECTOR)).toBe(true);
    expect(hasFilter(conn, "eq", "org_id", ORG)).toBe(true);
    expect(callsTo("connector_grants")).toEqual([]);
  });

  it("grants eligible keys in one insert, skips existing grants and reports the rest", async () => {
    // id(1) new, id(2) already granted, id(3) revoked, id(4) not in this org.
    m.respond.mockImplementation((c) => {
      if (c.table === "connectors") return { data: { id: CONNECTOR }, error: null };
      if (c.table === "api_keys") {
        return {
          data: [
            { id: id(1), revoked_at: null },
            { id: id(2), revoked_at: null },
            { id: id(3), revoked_at: "2026-09-01T00:00:00Z" },
          ],
          error: null,
        };
      }
      if (c.table === "connector_grants" && c.op === "upsert") return { data: [{ id: "g-new" }], error: null };
      if (c.table === "connector_grants" && c.op === "select") {
        return {
          data: [
            { id: "g-new", connector_id: CONNECTOR, api_key_id: id(1) },
            { id: "g-old", connector_id: CONNECTOR, api_key_id: id(2) },
          ],
          error: null,
        };
      }
      return undefined;
    });

    const res = await connectorsPost(
      req("/api/admin/connectors", "POST", grantBody([id(1), id(2), id(3), id(4)], { org_id: "evil-org" }))
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.granted).toEqual([id(1), id(2)]);
    expect(json.alreadyGranted).toEqual([id(2)]);
    expect(json.grants).toEqual([
      { id: "g-new", connector_id: CONNECTOR, api_key_id: id(1) },
      { id: "g-old", connector_id: CONNECTOR, api_key_id: id(2) },
    ]);
    expect(json.failed).toEqual([
      { id: id(3), error: "API key is revoked" },
      { id: id(4), error: "API key not found" },
    ]);

    const [keys] = callsTo("api_keys");
    expect(hasFilter(keys, "eq", "org_id", ORG)).toBe(true);
    expect(hasFilter(keys, "in", "id", [id(1), id(2), id(3), id(4)])).toBe(true);

    const upserts = callsTo("connector_grants", "upsert");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].payload).toEqual([
      { org_id: ORG, connector_id: CONNECTOR, api_key_id: id(1) },
      { org_id: ORG, connector_id: CONNECTOR, api_key_id: id(2) },
    ]);
    expect(upserts[0].options).toEqual({ onConflict: "connector_id,api_key_id", ignoreDuplicates: true });

    const [readBack] = callsTo("connector_grants", "select");
    expect(hasFilter(readBack, "eq", "org_id", ORG)).toBe(true);
    expect(hasFilter(readBack, "eq", "connector_id", CONNECTOR)).toBe(true);
  });

  it("writes nothing when no key is eligible", async () => {
    m.respond.mockImplementation((c) =>
      c.table === "connectors" ? { data: { id: CONNECTOR }, error: null } : { data: [], error: null }
    );
    const res = await connectorsPost(req("/api/admin/connectors", "POST", grantBody([id(1)])));
    expect(res.status).toBe(200);
    expect((await res.json()).failed).toEqual([{ id: id(1), error: "API key not found" }]);
    expect(callsTo("connector_grants")).toEqual([]);
  });

  it("500s when the insert fails", async () => {
    m.respond.mockImplementation((c) => {
      if (c.table === "connectors") return { data: { id: CONNECTOR }, error: null };
      if (c.table === "api_keys") return { data: [{ id: id(1), revoked_at: null }], error: null };
      if (c.op === "upsert") return { data: null, error: { message: "insert failed" } };
      return undefined;
    });
    const res = await connectorsPost(req("/api/admin/connectors", "POST", grantBody([id(1)])));
    expect(res.status).toBe(500);
  });

  it("keeps the single api_key_id contract", async () => {
    m.respond.mockImplementation((c) => {
      if (c.table === "connectors") return { data: { id: CONNECTOR }, error: null };
      if (c.table === "api_keys") return { data: { id: id(1) }, error: null };
      if (c.op === "insert") return { data: { id: "g-1", connector_id: CONNECTOR, api_key_id: id(1) }, error: null };
      return undefined;
    });
    const res = await connectorsPost(
      req("/api/admin/connectors", "POST", { action: "grant", connector_id: CONNECTOR, api_key_id: id(1) })
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ grant: { id: "g-1", connector_id: CONNECTOR, api_key_id: id(1) }, granted: true });
    expect(callsTo("connector_grants", "insert")[0].payload).toEqual({
      org_id: ORG,
      connector_id: CONNECTOR,
      api_key_id: id(1),
    });
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/connectors { grant_ids }
// ---------------------------------------------------------------------------

describe("DELETE /api/admin/connectors — remove many grants", () => {
  it("requires connectors:write", async () => {
    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Not authenticated", 401));
    const res = await connectorsDelete(req("/api/admin/connectors", "DELETE", { grant_ids: [id(1)] }));
    expect(res.status).toBe(401);
    expect(m.requireAdmin).toHaveBeenLastCalledWith("connectors:write");
    expect(m.calls).toEqual([]);
  });

  it.each([
    ["no body", undefined, "A grant_id is required"],
    ["an empty list", { grant_ids: [] }, "grant_ids must be a non-empty array of ids"],
    ["a non-uuid id", { grant_ids: ["abc)"] }, "grant_ids must be UUIDs"],
    ["more than 200 ids", { grant_ids: Array.from({ length: 201 }, (_, i) => id(i + 1)) }, "At most 200 grant_ids per request"],
  ])("400s on %s", async (_label, body, error) => {
    const res = await connectorsDelete(req("/api/admin/connectors", "DELETE", body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(error);
    expect(m.calls).toEqual([]);
  });

  it("deletes in ONE org-scoped statement and reports grants it did not find", async () => {
    m.respond.mockImplementation((c) => (c.op === "delete" ? { data: [{ id: id(2) }], error: null } : undefined));
    const res = await connectorsDelete(req("/api/admin/connectors", "DELETE", { grant_ids: [id(1), id(2)] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: [id(2)], failed: [{ id: id(1), error: "Grant not found" }] });

    const deletes = callsTo("connector_grants", "delete");
    expect(deletes).toHaveLength(1);
    expect(hasFilter(deletes[0], "in", "id", [id(1), id(2)])).toBe(true);
    expect(hasFilter(deletes[0], "eq", "org_id", ORG)).toBe(true);
  });

  it("500s when the delete fails", async () => {
    m.respond.mockImplementation((c) => (c.op === "delete" ? { data: null, error: { message: "nope" } } : undefined));
    const res = await connectorsDelete(req("/api/admin/connectors", "DELETE", { grant_ids: [id(1)] }));
    expect(res.status).toBe(500);
  });

  it("keeps the single ?grant_id= contract", async () => {
    m.respond.mockImplementation((c) => (c.op === "delete" ? { data: { id: id(9) }, error: null } : undefined));
    const res = await connectorsDelete(req(`/api/admin/connectors?grant_id=${id(9)}`, "DELETE"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: id(9), removed: true });
    const [d] = callsTo("connector_grants", "delete");
    expect(hasFilter(d, "eq", "id", id(9))).toBe(true);
    expect(hasFilter(d, "eq", "org_id", ORG)).toBe(true);
  });
});
