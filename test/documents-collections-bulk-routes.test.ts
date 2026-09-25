import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Bulk forms of DELETE /api/admin/documents ({ ids }) and of POST / DELETE
// /api/admin/collections/[id]/documents ({ document_ids }): auth, validation,
// org scoping on every statement, partial failure and the sync time budget.
// The admin session and Supabase are mocked; every query is recorded as its
// chain of builder calls (no network).

type Op = [string, unknown[]];
interface Call {
  table: string;
  ops: Op[];
}
interface DbResult {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
}

const m = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  calls: [] as { table: string; ops: [string, unknown[]][] }[],
  respond: (() => ({})) as (call: { table: string; ops: [string, unknown[]][] }) => {
    data?: unknown;
    error?: { message: string } | null;
    count?: number | null;
  },
}));

vi.mock("@/lib/auth/admin", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/admin")>()),
  requireAdmin: m.requireAdmin,
}));
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const call = { table, ops: [] as [string, unknown[]][] };
      m.calls.push(call);
      const q: Record<string, unknown> = {};
      for (const name of ["select", "insert", "update", "upsert", "delete", "eq", "neq", "in", "is", "order", "limit", "maybeSingle", "single"]) {
        q[name] = (...args: unknown[]) => {
          call.ops.push([name, args]);
          return q;
        };
      }
      q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => {
            const out = { data: null as unknown, error: null, count: null, ...m.respond(call) };
            // .maybeSingle() resolves to one row or null, as PostgREST does.
            if (call.ops.some(([n]) => n === "maybeSingle") && Array.isArray(out.data)) out.data = out.data[0] ?? null;
            return out;
          })
          .then(res, rej);
      return q;
    },
  }),
}));

import { DELETE as deleteDocuments } from "@/app/api/admin/documents/route";
import {
  POST as addToCollection,
  DELETE as removeFromCollection,
} from "@/app/api/admin/collections/[id]/documents/route";
import { AdminAuthError } from "@/lib/auth/admin";

const ORG = "org-1";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = uuid(1);
const B = uuid(2);
const C = uuid(3);
const COL = uuid(100);
const SRC = uuid(101);
const OTHER = uuid(102);

// ---- recorded-call helpers -------------------------------------------------
const verb = (c: Call) => c.ops[0]?.[0];
const opArgs = (c: Call, name: string, column?: string) =>
  c.ops.find(([n, a]) => n === name && (column === undefined || a[0] === column))?.[1];
const valueOf = (c: Call, name: string, column: string) => opArgs(c, name, column)?.[1];
const callsTo = (table: string, v?: string) => m.calls.filter((c) => c.table === table && (v === undefined || verb(c) === v));

/** Every statement filters by the session org (upserts carry it on every row instead). */
function expectOrgScoped() {
  expect(m.calls.length).toBeGreaterThan(0);
  for (const c of m.calls) {
    if (verb(c) === "upsert") {
      const rows = opArgs(c, "upsert")?.[0];
      for (const row of Array.isArray(rows) ? rows : [rows]) expect((row as { org_id: string }).org_id).toBe(ORG);
    } else {
      expect(valueOf(c, "eq", "org_id")).toBe(ORG);
    }
  }
}

// ---- a tiny org-scoped fake of the tables the routes touch ------------------
const db = {
  collections: new Set<string>(),
  documents: new Set<string>(),
  memberships: [] as { document_id: string; collection_id: string }[],
  failChunksFor: new Set<string>(),
  deleteError: null as string | null,
};

function respond(c: Call): DbResult {
  const inOrg = valueOf(c, "eq", "org_id") === ORG;
  if (c.table === "collections") {
    const id = valueOf(c, "eq", "id") as string;
    return { data: inOrg && db.collections.has(id) ? { id } : null };
  }
  if (c.table === "documents") {
    const one = valueOf(c, "eq", "id") as string | undefined;
    const ids = (valueOf(c, "in", "id") as string[] | undefined) ?? (one !== undefined ? [one] : []);
    if (verb(c) === "delete") {
      if (db.deleteError) return { error: { message: db.deleteError } };
      const single = valueOf(c, "eq", "id") as string | undefined;
      if (single !== undefined) return { count: inOrg && db.documents.has(single) ? 1 : 0 };
      return { data: inOrg ? ids.filter((id) => db.documents.has(id)).map((id) => ({ id })) : [] };
    }
    return { data: inOrg ? ids.filter((id) => db.documents.has(id)).map((id) => ({ id })) : [] };
  }
  if (c.table === "document_collections") {
    if (verb(c) === "upsert") {
      const rows = opArgs(c, "upsert")?.[0];
      for (const r of (Array.isArray(rows) ? rows : [rows]) as { document_id: string; collection_id: string }[]) {
        if (!db.memberships.some((x) => x.document_id === r.document_id && x.collection_id === r.collection_id)) {
          db.memberships.push({ document_id: r.document_id, collection_id: r.collection_id });
        }
      }
      return {};
    }
    const docIds = (valueOf(c, "in", "document_id") as string[] | undefined) ?? [valueOf(c, "eq", "document_id") as string];
    if (verb(c) === "delete") {
      const onlyCol = valueOf(c, "eq", "collection_id") as string | undefined;
      const notCol = valueOf(c, "neq", "collection_id") as string | undefined;
      const hit = (x: { document_id: string; collection_id: string }) =>
        inOrg &&
        docIds.includes(x.document_id) &&
        (onlyCol === undefined || x.collection_id === onlyCol) &&
        (notCol === undefined || x.collection_id !== notCol);
      const removed = db.memberships.filter(hit);
      db.memberships = db.memberships.filter((x) => !hit(x));
      return { data: removed.map((r) => ({ document_id: r.document_id })) };
    }
    return { data: inOrg ? db.memberships.filter((x) => docIds.includes(x.document_id)) : [] };
  }
  if (c.table === "chunks") {
    const docId = valueOf(c, "eq", "document_id") as string;
    return db.failChunksFor.has(docId) ? { error: { message: "statement timeout" } } : {};
  }
  return {};
}

/** The collection_ids the route last wrote onto a document's chunks. */
function chunkIdsFor(documentId: string): string[] | undefined {
  const c = [...callsTo("chunks", "update")].reverse().find((x) => valueOf(x, "eq", "document_id") === documentId);
  return (opArgs(c ?? { table: "", ops: [] }, "update")?.[0] as { collection_ids: string[] } | undefined)?.collection_ids;
}

function request(method: string, url: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const membersUrl = (id: string) => `/api/admin/collections/${id}/documents`;

beforeEach(() => {
  vi.clearAllMocks();
  m.calls = [];
  m.respond = respond;
  m.requireAdmin.mockResolvedValue({ orgId: ORG, userId: "user-1", role: "admin", permissions: {} });
  db.collections = new Set([COL, SRC, OTHER]);
  db.documents = new Set([A, B]);
  db.memberships = [];
  db.failChunksFor = new Set();
  db.deleteError = null;
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe("DELETE /api/admin/documents — bulk { ids }", () => {
  it("passes 401 / 403 through without touching the database", async () => {
    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Not authenticated", 401));
    expect((await deleteDocuments(request("DELETE", "/api/admin/documents", { ids: [A] }))).status).toBe(401);
    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Missing permission 'documents:write'", 403));
    expect((await deleteDocuments(request("DELETE", "/api/admin/documents", { ids: [A] }))).status).toBe(403);
    expect(m.requireAdmin).toHaveBeenCalledWith("documents:write");
    expect(m.calls).toHaveLength(0);
  });

  it.each([
    ["no body", undefined],
    ["no ids", { id: A }],
    ["an empty list", { ids: [] }],
    ["a non-array", { ids: A }],
    ["a non-UUID", { ids: [A, "not-a-uuid"] }],
    ["more than 200 ids", { ids: Array.from({ length: 201 }, (_, i) => uuid(1000 + i)) }],
  ])("rejects %s with 400", async (_label, body) => {
    const res = await deleteDocuments(request("DELETE", "/api/admin/documents", body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toEqual(expect.any(String));
    expect(m.calls).toHaveLength(0);
  });

  it("deletes in ONE org-scoped statement and reports ids that matched nothing", async () => {
    // A foreign or already-deleted id (C) matches nothing; a client org_id is ignored.
    const res = await deleteDocuments(
      request("DELETE", "/api/admin/documents", { ids: [A, B.toUpperCase(), C, A], org_id: "org-2" })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      deleted: 2,
      ids: [A, B],
      failed: [{ id: C, error: "Document not found" }],
    });
    expect(m.calls).toHaveLength(1);
    const [c] = m.calls;
    expect(c.table).toBe("documents");
    expect(verb(c)).toBe("delete");
    expect(valueOf(c, "in", "id")).toEqual([A, B, C]);
    expect(opArgs(c, "select")).toEqual(["id"]);
    expectOrgScoped();
  });

  it("returns 500 when the delete fails", async () => {
    db.deleteError = "permission denied";
    const res = await deleteDocuments(request("DELETE", "/api/admin/documents", { ids: [A] }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("permission denied");
  });

  it("keeps the single ?id= form", async () => {
    const ok = await deleteDocuments(request("DELETE", `/api/admin/documents?id=${A}`));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    const [c] = m.calls;
    expect(opArgs(c, "delete")).toEqual([{ count: "exact" }]);
    expect(valueOf(c, "eq", "id")).toBe(A);
    expectOrgScoped();

    const missing = await deleteDocuments(request("DELETE", `/api/admin/documents?id=${C}`));
    expect(missing.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe("demo mode ids (the in-memory store uses short ids like doc-1)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("bulk delete, add and move accept demo ids only in demo mode", async () => {
    db.documents = new Set(["doc-1", "doc-2"]);
    db.collections = new Set(["col-1", "col-2"]);

    // Outside demo mode they are still rejected before any query.
    expect((await deleteDocuments(request("DELETE", "/api/admin/documents", { ids: ["doc-1"] }))).status).toBe(400);
    expect((await addToCollection(request("POST", membersUrl("col-1"), { document_ids: ["doc-1"] }), params("col-1"))).status).toBe(400);
    expect(m.calls).toHaveLength(0);

    vi.stubEnv("DEMO_MODE", "1");
    const del = await deleteDocuments(request("DELETE", "/api/admin/documents", { ids: ["doc-1", "doc-2"] }));
    expect(del.status).toBe(200);
    expect((await del.json()).ids).toEqual(["doc-1", "doc-2"]);

    db.documents = new Set(["doc-3"]);
    const add = await addToCollection(request("POST", membersUrl("col-1"), { document_ids: ["doc-3"] }), params("col-1"));
    expect(add.status).toBe(200);
    const move = await addToCollection(
      request("POST", membersUrl("col-1"), { document_ids: ["doc-3"], from_collection_id: "col-2" }),
      params("col-1")
    );
    expect(move.status).toBe(200);
    // Still no free-form ids, even in demo mode.
    expect((await deleteDocuments(request("DELETE", "/api/admin/documents", { ids: ["doc 1; drop"] }))).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe("POST /api/admin/collections/[id]/documents — bulk { document_ids }", () => {
  it("passes 401 / 403 through without touching the database", async () => {
    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Not authenticated", 401));
    expect((await addToCollection(request("POST", membersUrl(COL), { document_ids: [A] }), params(COL))).status).toBe(401);
    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Missing permission 'collections:write'", 403));
    expect((await addToCollection(request("POST", membersUrl(COL), { document_ids: [A] }), params(COL))).status).toBe(403);
    expect(m.requireAdmin).toHaveBeenCalledWith("collections:write");
    expect(m.calls).toHaveLength(0);
  });

  it.each([
    ["an empty list", { document_ids: [] }],
    ["a non-UUID", { document_ids: ["x"] }],
    ["more than 200 ids", { document_ids: Array.from({ length: 201 }, (_, i) => uuid(1000 + i)) }],
    ["a bad from_collection_id", { document_ids: [A], from_collection_id: "nope" }],
    ["from_collection_id with exclusive", { document_ids: [A], from_collection_id: SRC, exclusive: true }],
  ])("rejects %s with 400", async (_label, body) => {
    const res = await addToCollection(request("POST", membersUrl(COL), body), params(COL));
    expect(res.status).toBe(400);
    expect(m.calls).toHaveLength(0);
  });

  it("404s for a collection outside the org, writing nothing", async () => {
    db.collections.delete(COL);
    const res = await addToCollection(request("POST", membersUrl(COL), { document_ids: [A, B] }), params(COL));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Collection not found");
    expect(callsTo("document_collections")).toHaveLength(0);
    expect(callsTo("chunks")).toHaveLength(0);
  });

  it("adds in one upsert, re-syncs each document's chunks and reports unknown documents", async () => {
    db.memberships = [{ document_id: B, collection_id: OTHER }];
    const res = await addToCollection(
      request("POST", membersUrl(COL), { document_ids: [A, B, C], org_id: "org-2" }),
      params(COL)
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      ids: [A, B],
      failed: [{ id: C, error: "Document not found" }],
      remaining: [],
    });

    const upserts = callsTo("document_collections", "upsert");
    expect(upserts).toHaveLength(1);
    expect(opArgs(upserts[0], "upsert")).toEqual([
      [
        { org_id: ORG, document_id: A, collection_id: COL },
        { org_id: ORG, document_id: B, collection_id: COL },
      ],
      { onConflict: "document_id,collection_id", ignoreDuplicates: true },
    ]);
    expect(callsTo("document_collections", "delete")).toHaveLength(0);
    expect(chunkIdsFor(A)).toEqual([COL]);
    expect(chunkIdsFor(B)?.slice().sort()).toEqual([COL, OTHER].sort());
    expect(chunkIdsFor(C)).toBeUndefined();
    expectOrgScoped();
  });

  it("moves from a source collection (other memberships kept)", async () => {
    db.memberships = [
      { document_id: A, collection_id: SRC },
      { document_id: A, collection_id: OTHER },
    ];
    const res = await addToCollection(
      request("POST", membersUrl(COL), { document_ids: [A], from_collection_id: SRC }),
      params(COL)
    );
    expect(res.status).toBe(200);
    const [del] = callsTo("document_collections", "delete");
    expect(valueOf(del, "eq", "collection_id")).toBe(SRC);
    expect(valueOf(del, "in", "document_id")).toEqual([A]);
    expect(chunkIdsFor(A)?.slice().sort()).toEqual([COL, OTHER].sort());
    expectOrgScoped();
  });

  it("404s when the source collection is outside the org", async () => {
    db.collections.delete(SRC);
    const res = await addToCollection(
      request("POST", membersUrl(COL), { document_ids: [A], from_collection_id: SRC }),
      params(COL)
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Source collection not found");
    expect(callsTo("document_collections")).toHaveLength(0);
  });

  it("exclusive: the target becomes each document's only collection", async () => {
    db.memberships = [
      { document_id: A, collection_id: SRC },
      { document_id: A, collection_id: OTHER },
    ];
    const res = await addToCollection(
      request("POST", membersUrl(COL), { document_ids: [A], exclusive: true }),
      params(COL)
    );
    expect(res.status).toBe(200);
    const [del] = callsTo("document_collections", "delete");
    expect(valueOf(del, "neq", "collection_id")).toBe(COL);
    expect(chunkIdsFor(A)).toEqual([COL]);
    expectOrgScoped();
  });

  it("reports a document whose chunk sync fails, the rest succeed", async () => {
    db.failChunksFor.add(B);
    const res = await addToCollection(request("POST", membersUrl(COL), { document_ids: [A, B] }), params(COL));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ids).toEqual([A]);
    expect(json.failed).toEqual([{ id: B, error: expect.stringMatching(/search index/) }]);
  });

  it("hands documents it had no time to sync back as `remaining`", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => uuid(500 + i));
    db.documents = new Set(ids);
    // Request start and the first slice's check are on time; the second slice is past the budget.
    let n = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (n++ < 2 ? 1_000 : 1_000 + 60_000));
    const res = await addToCollection(request("POST", membersUrl(COL), { document_ids: ids }), params(COL));
    const json = await res.json();
    expect(json.ids).toEqual(ids.slice(0, 20));
    expect(json.remaining).toEqual(ids.slice(20));
    expect(json.failed).toEqual([]);
  });

  it("keeps the single { document_id } form", async () => {
    const res = await addToCollection(request("POST", membersUrl(COL), { document_id: A }), params(COL));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, added: true });
    const [upsert] = callsTo("document_collections", "upsert");
    expect(opArgs(upsert, "upsert")?.[0]).toEqual({ org_id: ORG, document_id: A, collection_id: COL });
    expect(chunkIdsFor(A)).toEqual([COL]);
    expectOrgScoped();
  });
});

// ---------------------------------------------------------------------------
describe("DELETE /api/admin/collections/[id]/documents — bulk { document_ids }", () => {
  it("passes 403 through without touching the database", async () => {
    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Missing permission 'collections:write'", 403));
    const res = await removeFromCollection(request("DELETE", membersUrl(COL), { document_ids: [A] }), params(COL));
    expect(res.status).toBe(403);
    expect(m.calls).toHaveLength(0);
  });

  it("400s without a document_id or a document_ids body", async () => {
    expect((await removeFromCollection(request("DELETE", membersUrl(COL)), params(COL))).status).toBe(400);
    expect(
      (await removeFromCollection(request("DELETE", membersUrl(COL), { document_ids: ["x"] }), params(COL))).status
    ).toBe(400);
    expect(m.calls).toHaveLength(0);
  });

  it("404s for a collection outside the org", async () => {
    db.collections.delete(COL);
    const res = await removeFromCollection(request("DELETE", membersUrl(COL), { document_ids: [A] }), params(COL));
    expect(res.status).toBe(404);
    expect(callsTo("document_collections")).toHaveLength(0);
  });

  it("removes in one org-scoped statement and re-syncs the chunks", async () => {
    db.memberships = [
      { document_id: A, collection_id: COL },
      { document_id: B, collection_id: COL },
      { document_id: B, collection_id: OTHER },
    ];
    const res = await removeFromCollection(
      request("DELETE", membersUrl(COL), { document_ids: [A, B, C] }),
      params(COL)
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      removed: 2,
      ids: [A, B],
      failed: [{ id: C, error: "Document not found" }],
      remaining: [],
    });
    const dels = callsTo("document_collections", "delete");
    expect(dels).toHaveLength(1);
    expect(valueOf(dels[0], "eq", "collection_id")).toBe(COL);
    expect(valueOf(dels[0], "in", "document_id")).toEqual([A, B]);
    expect(chunkIdsFor(A)).toEqual([]);
    expect(chunkIdsFor(B)).toEqual([OTHER]);
    expectOrgScoped();
  });

  it("keeps the single ?document_id= form", async () => {
    const res = await removeFromCollection(request("DELETE", `${membersUrl(COL)}?document_id=${A}`), params(COL));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Document is not in this collection");
    expectOrgScoped();
  });
});
