import { describe, it, expect, beforeEach, vi } from "vitest";

// RBAC boundary for group-1 (documents + knowledge objects/entities).
//
// Unlike the bulk-route tests, this one does NOT stub requireAdmin: it mocks only
// getAdmin (the session) and Supabase, so the REAL requireAdmin + hasPermission +
// hasAction (permissions.ts) decide every request. That is what proves the split
// the product owner asked for:
//   - documents:write lets a member upload/curate but NEVER delete;
//   - destroying data (delete document/object/entity, bulk delete, entity merge)
//     needs documents:delete;
//   - reading the back office needs documents:read (write/delete imply it);
//   - super_admin bypasses all.
// A denied request is refused before ANY Supabase call (guard runs first).

type AdminSession = import("@/lib/auth/session").AdminSession;

const m = vi.hoisted(() => ({
  session: null as unknown,
  /** How many times a Supabase query builder was opened this request. */
  fromCalls: 0,
}));

// Real requireAdmin/hasPermission; only the session lookup is faked.
vi.mock("@/lib/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/session")>()),
  getAdmin: vi.fn(async () => m.session),
}));

// A permissive in-memory Supabase: awaiting any chain yields { data: null } (empty
// results), so a handler that PASSES the guard runs to a real 200/404/400 rather
// than a permission error. A refused handler never reaches here (fromCalls stays 0).
function makeQ(): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  for (const name of ["select", "insert", "update", "upsert", "delete", "eq", "neq", "in", "is", "not", "or", "order", "limit", "range", "filter", "gte", "lte"]) {
    q[name] = () => q;
  }
  q.maybeSingle = async () => ({ data: null, error: null });
  q.single = async () => ({ data: null, error: null });
  q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve({ data: null, error: null, count: null }).then(res, rej);
  return q;
}
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from: () => {
      m.fromCalls += 1;
      return makeQ();
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));
// objects/[id]/route.ts pulls these in at import; the paths under test never call them.
vi.mock("@/lib/ingest", () => ({ reingestDocument: vi.fn(async () => ({ chunks: 0 })) }));
vi.mock("@/lib/embeddings", () => ({ embed: vi.fn(async () => []), embedMany: vi.fn(async () => []) }));

import { GET as docsGet, DELETE as docsDelete } from "@/app/api/admin/documents/route";
import { GET as docGet, PATCH as docPatch, DELETE as docDelete } from "@/app/api/admin/documents/[id]/route";
import { GET as inspectGet } from "@/app/api/admin/documents/[id]/inspect/route";
import { GET as objectsGet, PATCH as objectsPatch, DELETE as objectsDelete } from "@/app/api/admin/knowledge/objects/route";
import { GET as objectGet, PATCH as objectPatch, DELETE as objectDelete } from "@/app/api/admin/knowledge/objects/[id]/route";
import { GET as entitiesGet, POST as entitiesPost, DELETE as entitiesDelete } from "@/app/api/admin/knowledge/entities/route";

// --- sessions ---------------------------------------------------------------
const ORG = "org-1";
const base = (over: Partial<AdminSession>): AdminSession => ({
  userId: "u-1",
  orgId: ORG,
  email: "member@practiscale.co",
  memberId: "mem-1",
  role: "admin",
  permissions: {},
  ...over,
});
/** The "Knowledge uploader" preset saleh.practiscale@gmail.com will get: write, no delete. */
const UPLOADER = base({ permissions: { documents: ["read", "write"], collections: ["read", "write"], data_sources: ["read"], analytics: ["read"] } });
/** documents:[write] only — proves read is implied by write. */
const WRITE_ONLY = base({ permissions: { documents: ["write"] } });
/** Read-only analyst — no write, no delete. */
const READONLY = base({ permissions: { documents: ["read"], collections: ["read"], analytics: ["read"] } });
/** Holds delete — the destructive paths must let them through. */
const DELETER = base({ permissions: { documents: ["read", "write", "delete"] } });
/** No documents grant at all — every documents read/write/delete is refused. */
const NO_DOCS = base({ permissions: { collections: ["read"] } });
const SUPER = base({ role: "super_admin", permissions: {} });

// --- request helpers --------------------------------------------------------
const DOCS_URL = "http://localhost/api/admin/documents";
const OBJECTS_URL = "http://localhost/api/admin/knowledge/objects";
const ENTITIES_URL = "http://localhost/api/admin/knowledge/entities";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DOC = uuid(1);
const OBJ = uuid(2);
const ENT = uuid(3);
const ENT2 = uuid(4);

function req(method: string, url: string, body?: unknown): Request {
  return new Request(url, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
/** A handler PASSED its permission gate: not an auth (401) or forbidden (403) response. */
function expectPassed(status: number) {
  expect(status).not.toBe(401);
  expect(status).not.toBe(403);
}

beforeEach(() => {
  m.session = null;
  m.fromCalls = 0;
});

// ---------------------------------------------------------------------------
// Read GETs — require documents:read (write/delete imply it; super_admin bypass).
// ---------------------------------------------------------------------------
const reads: [string, () => Promise<Response>][] = [
  ["GET /documents", () => docsGet()],
  ["GET /documents/[id]", () => docGet(req("GET", `${DOCS_URL}/${DOC}`), ctx(DOC))],
  ["GET /documents/[id]/inspect", () => inspectGet(req("GET", `${DOCS_URL}/${DOC}/inspect`), ctx(DOC))],
  ["GET /knowledge/objects", () => objectsGet(req("GET", OBJECTS_URL))],
  ["GET /knowledge/objects/[id]", () => objectGet(req("GET", `${OBJECTS_URL}/${OBJ}`), ctx(OBJ))],
  ["GET /knowledge/entities", () => entitiesGet(req("GET", ENTITIES_URL))],
];

describe("read GETs require documents:read", () => {
  it.each(reads)("%s → 403 for a member without documents, before any query", async (_label, call) => {
    m.session = NO_DOCS;
    expect((await call()).status).toBe(403);
    expect(m.fromCalls).toBe(0);
  });

  it.each(reads)("%s → allowed for a read-only member", async (_label, call) => {
    m.session = READONLY;
    expectPassed((await call()).status);
  });

  it.each(reads)("%s → allowed for super_admin", async (_label, call) => {
    m.session = SUPER;
    expectPassed((await call()).status);
  });

  it("a write-only member still passes a read GET (read implied by write)", async () => {
    m.session = WRITE_ONLY;
    expectPassed((await objectsGet(req("GET", OBJECTS_URL))).status);
  });

  it("the list GETs return a clean 200 once the gate passes", async () => {
    m.session = UPLOADER;
    expect((await docsGet()).status).toBe(200);
    expect((await objectsGet(req("GET", OBJECTS_URL))).status).toBe(200);
    expect((await entitiesGet(req("GET", ENTITIES_URL))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Destructive routes — require documents:delete (single AND bulk / merge).
// ---------------------------------------------------------------------------
const destructive: [string, () => Promise<Response>][] = [
  ["DELETE /documents?id= (single)", () => docsDelete(req("DELETE", `${DOCS_URL}?id=${DOC}`))],
  ["DELETE /documents { ids } (bulk)", () => docsDelete(req("DELETE", DOCS_URL, { ids: [DOC] }))],
  ["DELETE /documents/[id]", () => docDelete(req("DELETE", `${DOCS_URL}/${DOC}`), ctx(DOC))],
  ["DELETE /knowledge/objects { ids } (bulk)", () => objectsDelete(req("DELETE", OBJECTS_URL, { ids: [OBJ] }))],
  ["DELETE /knowledge/objects/[id]", () => objectDelete(req("DELETE", `${OBJECTS_URL}/${OBJ}`), ctx(OBJ))],
  ["DELETE /knowledge/entities { ids } (bulk)", () => entitiesDelete(req("DELETE", ENTITIES_URL, { ids: [ENT] }))],
  ["POST /knowledge/entities (merge)", () => entitiesPost(req("POST", ENTITIES_URL, { action: "merge", ids: [ENT], targetId: ENT2 }))],
];

describe("destructive routes require documents:delete", () => {
  it.each(destructive)("%s → 403 for an uploader (write but not delete), before any query", async (_label, call) => {
    m.session = UPLOADER;
    expect((await call()).status).toBe(403);
    expect(m.fromCalls).toBe(0);
  });

  it.each(destructive)("%s → 403 for a read-only member", async (_label, call) => {
    m.session = READONLY;
    expect((await call()).status).toBe(403);
  });

  it.each(destructive)("%s → allowed for a member holding documents:delete", async (_label, call) => {
    m.session = DELETER;
    expectPassed((await call()).status);
  });

  it.each(destructive)("%s → allowed for super_admin", async (_label, call) => {
    m.session = SUPER;
    expectPassed((await call()).status);
  });

  it("the bulk deletes return a clean 200 once the gate passes", async () => {
    m.session = DELETER;
    expect((await docsDelete(req("DELETE", DOCS_URL, { ids: [DOC] }))).status).toBe(200);
    expect((await objectsDelete(req("DELETE", OBJECTS_URL, { ids: [OBJ] }))).status).toBe(200);
    expect((await entitiesDelete(req("DELETE", ENTITIES_URL, { ids: [ENT] }))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Curate / upload writes — require documents:write; an uploader is allowed, a
// read-only member is refused. These NEVER move to :delete.
// ---------------------------------------------------------------------------
const writes: [string, () => Promise<Response>][] = [
  ["PATCH /documents/[id] (edit title)", () => docPatch(req("PATCH", `${DOCS_URL}/${DOC}`, { title: "Renamed" }), ctx(DOC))],
  ["PATCH /knowledge/objects { ids, patch } (bulk governance)", () => objectsPatch(req("PATCH", OBJECTS_URL, { ids: [OBJ], patch: { status: "archived" } }))],
  ["PATCH /knowledge/objects/[id] (curate)", () => objectPatch(req("PATCH", `${OBJECTS_URL}/${OBJ}`, { status: "archived" }), ctx(OBJ))],
];

describe("curate/upload writes require documents:write", () => {
  it.each(writes)("%s → allowed for an uploader", async (_label, call) => {
    m.session = UPLOADER;
    expectPassed((await call()).status);
  });

  it.each(writes)("%s → 403 for a read-only member, before any query", async (_label, call) => {
    m.session = READONLY;
    expect((await call()).status).toBe(403);
    expect(m.fromCalls).toBe(0);
  });

  it.each(writes)("%s → allowed for super_admin", async (_label, call) => {
    m.session = SUPER;
    expectPassed((await call()).status);
  });

  it("bulk governance curate returns a clean 200 for an uploader (no delete needed)", async () => {
    m.session = UPLOADER;
    expect((await objectsPatch(req("PATCH", OBJECTS_URL, { ids: [OBJ], patch: { status: "archived" } }))).status).toBe(200);
  });
});
