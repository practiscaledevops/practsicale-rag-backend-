import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// RBAC for the collections routes this group owns. The single item and its
// document-membership routes are gated so that:
//   - GET                          → collections:read   (write/delete imply read)
//   - POST (create) / PATCH        → collections:write
//   - DELETE a collection          → collections:delete (DESTROYS data)
//   - POST/DELETE a document link  → collections:write  (moving docs is NOT a delete)
//
// The auth guard is exercised with the REAL catalogue logic (can()): requireAdmin
// is mocked to a fake session and throws 401/403 exactly when can() says the key
// is not held. So "a member with write-but-not-delete is 403 on DELETE /[id] but
// 200 on create/rename/link/unlink" is proven behaviourally, not just by asserting
// which string the route passed. Supabase is a tiny in-memory fake — no network.

import { can, type PermissionSubject } from "@/lib/auth/permissions";
import { AdminAuthError } from "@/lib/auth/admin";

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
            if (call.ops.some(([n]) => n === "maybeSingle") && Array.isArray(out.data)) out.data = out.data[0] ?? null;
            return out;
          })
          .then(res, rej);
      return q;
    },
  }),
}));

import { GET as listCollections, POST as createCollection } from "@/app/api/admin/collections/route";
import { PATCH as patchCollection, DELETE as deleteCollection } from "@/app/api/admin/collections/[id]/route";
import { POST as addDocument, DELETE as removeDocument } from "@/app/api/admin/collections/[id]/documents/route";

const ORG = "org-1";
const NOW = "2026-01-01T00:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const COL = uuid(100);
const DOC = uuid(1);

// ---- recorded-call helpers -------------------------------------------------
const verb = (c: Call) => c.ops[0]?.[0];
const opArgs = (c: Call, name: string, column?: string) =>
  c.ops.find(([n, a]) => n === name && (column === undefined || a[0] === column))?.[1];
const valueOf = (c: Call, name: string, column: string) => opArgs(c, name, column)?.[1];

/** Every statement filters by the session org (inserts carry it on the row instead). */
function expectOrgScoped() {
  for (const c of m.calls) {
    if (verb(c) === "insert") {
      const row = opArgs(c, "insert")?.[0] as { org_id?: string };
      expect(row.org_id).toBe(ORG);
    } else if (verb(c) === "upsert") {
      const rows = opArgs(c, "upsert")?.[0];
      for (const row of Array.isArray(rows) ? rows : [rows]) expect((row as { org_id: string }).org_id).toBe(ORG);
    } else {
      expect(valueOf(c, "eq", "org_id")).toBe(ORG);
    }
  }
}

// ---- the fake tables the routes touch (happy path) --------------------------
function respond(c: Call): DbResult {
  const v = verb(c);
  const single = c.ops.some(([n]) => n === "maybeSingle" || n === "single");
  if (c.table === "collections") {
    if (v === "select") {
      // GET list vs. an org membership probe (collectionInOrg / maybeSingle).
      const row = {
        id: COL,
        name: "Docs",
        slug: "docs",
        description: null,
        created_at: NOW,
        document_collections: [{ count: 2 }],
      };
      return single ? { data: { id: COL } } : { data: [row] };
    }
    if (v === "insert") return { data: { id: COL, name: "New collection", slug: "new-collection", description: null, created_at: NOW } };
    if (v === "update") return { data: { id: COL, name: "Renamed", slug: "renamed", description: null, created_at: NOW } };
    if (v === "delete") return { data: { id: COL } };
  }
  if (c.table === "documents") return { data: { id: DOC } };
  if (c.table === "document_collections") {
    if (v === "upsert") return {};
    if (v === "delete") return { data: { document_id: DOC } };
    return { data: [] }; // syncChunkCollectionIds membership read
  }
  if (c.table === "chunks") return {};
  return {};
}

// ---- subjects (role + permissions) evaluated by the real can() --------------
const WRITER: PermissionSubject = { role: "admin", permissions: { collections: ["read", "write"], documents: ["read", "write"] } };
const DELETER: PermissionSubject = { role: "admin", permissions: { collections: ["read", "write", "delete"] } };
const READER: PermissionSubject = { role: "admin", permissions: { collections: ["read"] } };
const NO_COLLECTIONS: PermissionSubject = { role: "admin", permissions: { documents: ["read"] } };
const SUPER: PermissionSubject = { role: "super_admin", permissions: {} };

let subject: PermissionSubject = READER;
const as = (s: PermissionSubject) => {
  subject = s;
};

function request(method: string, url: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const colUrl = "/api/admin/collections";
const idUrl = (id: string) => `/api/admin/collections/${id}`;
const docsUrl = (id: string) => `/api/admin/collections/${id}/documents`;

beforeEach(() => {
  vi.clearAllMocks();
  m.calls = [];
  m.respond = respond;
  subject = READER;
  // requireAdmin enforces the SAME rule the real one does (can(): read implied by
  // write/delete, super_admin bypass), against the current test subject.
  m.requireAdmin.mockImplementation(async (key?: string) => {
    if (key && !can(subject, key)) throw new AdminAuthError(`Missing permission '${key}'`, 403);
    return { orgId: ORG, userId: "user-1", memberId: "mem-1", email: "member@example.com", role: subject.role, permissions: subject.permissions };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe("GET /api/admin/collections — collections:read", () => {
  it("403s a member with no collections grant, touching no table", async () => {
    as(NO_COLLECTIONS);
    const res = await listCollections();
    expect(res.status).toBe(403);
    expect(m.requireAdmin).toHaveBeenCalledWith("collections:read");
    expect(m.calls).toHaveLength(0);
  });

  it("200s a reader, a writer (read is implied) and super_admin", async () => {
    for (const s of [READER, WRITER, SUPER]) {
      m.calls = [];
      as(s);
      const res = await listCollections();
      expect(res.status).toBe(200);
      expect((await res.json()).collections).toHaveLength(1);
      expectOrgScoped();
    }
  });
});

// ---------------------------------------------------------------------------
describe("POST /api/admin/collections — collections:write", () => {
  it("403s a read-only member before any write", async () => {
    as(READER);
    const res = await createCollection(request("POST", colUrl, { name: "New collection" }));
    expect(res.status).toBe(403);
    expect(m.requireAdmin).toHaveBeenCalledWith("collections:write");
    expect(m.calls).toHaveLength(0);
  });

  it("201s a writer and a super_admin, org-scoped on the insert", async () => {
    for (const s of [WRITER, SUPER]) {
      m.calls = [];
      as(s);
      const res = await createCollection(request("POST", colUrl, { name: "New collection", org_id: "org-2" }));
      expect(res.status).toBe(201);
      expect((await res.json()).collection.id).toBe(COL);
      expectOrgScoped();
    }
  });
});

// ---------------------------------------------------------------------------
describe("PATCH /api/admin/collections/[id] — collections:write", () => {
  it("403s a read-only member", async () => {
    as(READER);
    const res = await patchCollection(request("PATCH", idUrl(COL), { name: "Renamed" }), params(COL));
    expect(res.status).toBe(403);
    expect(m.requireAdmin).toHaveBeenCalledWith("collections:write");
    expect(m.calls).toHaveLength(0);
  });

  it("200s a writer (write-but-not-delete can still rename)", async () => {
    as(WRITER);
    const res = await patchCollection(request("PATCH", idUrl(COL), { name: "Renamed" }), params(COL));
    expect(res.status).toBe(200);
    expect((await res.json()).collection.id).toBe(COL);
    expectOrgScoped();
  });
});

// ---------------------------------------------------------------------------
describe("DELETE /api/admin/collections/[id] — collections:delete (destructive)", () => {
  it("403s a member with write but NOT delete, destroying nothing", async () => {
    as(WRITER); // collections:[read,write] — no delete
    const res = await deleteCollection(request("DELETE", idUrl(COL)), params(COL));
    expect(res.status).toBe(403);
    // The route demands the dedicated delete grant, not write.
    expect(m.requireAdmin).toHaveBeenCalledWith("collections:delete");
    expect(m.requireAdmin).not.toHaveBeenCalledWith("collections:write");
    expect(m.calls).toHaveLength(0);
  });

  it("200s a member holding collections:delete and re-scopes the delete to the org", async () => {
    as(DELETER);
    const res = await deleteCollection(request("DELETE", idUrl(COL)), params(COL));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: COL, removed: true });
    const del = m.calls.find((c) => c.table === "collections" && verb(c) === "delete")!;
    expect(valueOf(del, "eq", "id")).toBe(COL);
    expectOrgScoped();
  });

  it("200s a super_admin (bypasses all)", async () => {
    as(SUPER);
    const res = await deleteCollection(request("DELETE", idUrl(COL)), params(COL));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Linking documents is curation (moving docs between collections), NOT a delete —
// so it stays on collections:write even though one path is an HTTP DELETE.
describe("POST /api/admin/collections/[id]/documents — collections:write (link)", () => {
  it("403s a read-only member", async () => {
    as(READER);
    const res = await addDocument(request("POST", docsUrl(COL), { document_id: DOC }), params(COL));
    expect(res.status).toBe(403);
    expect(m.requireAdmin).toHaveBeenCalledWith("collections:write");
    expect(m.calls).toHaveLength(0);
  });

  it("201s a writer (write-but-not-delete can add a document)", async () => {
    as(WRITER);
    const res = await addDocument(request("POST", docsUrl(COL), { document_id: DOC }), params(COL));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, added: true });
    expectOrgScoped();
  });
});

describe("DELETE /api/admin/collections/[id]/documents — STAYS collections:write (unlink)", () => {
  it("200s a member with write but NOT delete — unlink was NOT moved to :delete", async () => {
    as(WRITER); // no collections:delete, yet the unlink succeeds
    const res = await removeDocument(request("DELETE", `${docsUrl(COL)}?document_id=${DOC}`), params(COL));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true });
    expect(m.requireAdmin).toHaveBeenCalledWith("collections:write");
    expect(m.requireAdmin).not.toHaveBeenCalledWith("collections:delete");
    expectOrgScoped();
  });

  it("403s a read-only member", async () => {
    as(READER);
    const res = await removeDocument(request("DELETE", `${docsUrl(COL)}?document_id=${DOC}`), params(COL));
    expect(res.status).toBe(403);
    expect(m.calls).toHaveLength(0);
  });
});
