import { describe, it, expect, vi, beforeEach } from "vitest";

// Bulk actions on the knowledge admin routes:
//  - /api/admin/knowledge/objects: PATCH / DELETE with { ids } (bulk governance
//    and delete), plus the single-object PATCH on objects/[id], which now shares
//    its governance rules (objects/_governance.ts);
//  - /api/admin/knowledge/entities: POST { action: "merge" } and DELETE { ids }.
// Auth and the database are faked in memory; every statement is recorded so
// org scoping can be asserted.
const m = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  type Filter = { col: string; op: "eq" | "in"; val: unknown };
  interface Stmt {
    table: string;
    op: "select" | "insert" | "update" | "delete";
    filters: Filter[];
    payload?: unknown;
  }
  const state = {
    tables: {} as Record<string, Row[]>,
    log: [] as Stmt[],
    /** Updates touching one of these ids fail (partial-failure tests). */
    failUpdate: new Set<string>(),
    /** Deletes touching one of these ids fail, deleting nothing (partial-failure tests). */
    failDelete: new Set<string>(),
    /** db.rpc(name, params): the SQL functions the routes call. */
    rpc: (_name: string, _params: unknown): { data: unknown; error: unknown } => ({ data: null, error: null }),
    rpcCalls: [] as { name: string; params: unknown }[],
  };

  class Query implements PromiseLike<{ data: unknown; error: unknown }> {
    private filters: Filter[] = [];
    private op: Stmt["op"] = "select";
    private payload: unknown;
    private one = false;
    constructor(private table: string) {}
    select() {
      return this;
    }
    insert(p: unknown) {
      this.op = "insert";
      this.payload = p;
      return this;
    }
    update(p: unknown) {
      this.op = "update";
      this.payload = p;
      return this;
    }
    delete() {
      this.op = "delete";
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters.push({ col, op: "eq", val });
      return this;
    }
    in(col: string, val: unknown[]) {
      this.filters.push({ col, op: "in", val });
      return this;
    }
    or() {
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    single() {
      this.one = true;
      return Promise.resolve(this.exec());
    }
    maybeSingle() {
      this.one = true;
      return Promise.resolve(this.exec());
    }
    then<A = { data: unknown; error: unknown }, B = never>(
      res?: ((v: { data: unknown; error: unknown }) => A | PromiseLike<A>) | null,
      rej?: ((e: unknown) => B | PromiseLike<B>) | null
    ): Promise<A | B> {
      return Promise.resolve(this.exec()).then(res, rej);
    }
    private matches(r: Row) {
      return this.filters.every((f) => (f.op === "eq" ? r[f.col] === f.val : (f.val as unknown[]).includes(r[f.col])));
    }
    private exec(): { data: unknown; error: unknown } {
      state.log.push({ table: this.table, op: this.op, filters: this.filters, payload: this.payload });
      const rows = (state.tables[this.table] ||= []);
      if (this.op === "insert") {
        const list = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
        rows.push(...list.map((r) => ({ ...r })));
        return { data: list, error: null };
      }
      if (this.op === "update") {
        const hit = rows.filter((r) => this.matches(r));
        if (hit.some((r) => state.failUpdate.has(String(r.id)))) return { data: null, error: { message: "update exploded" } };
        for (const r of hit) Object.assign(r, this.payload as Row);
        if (this.one) return hit[0] ? { data: { ...hit[0] }, error: null } : { data: null, error: { message: "0 rows" } };
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      if (this.op === "delete") {
        const kept = rows.filter((r) => !this.matches(r));
        const removed = rows.filter((r) => this.matches(r));
        if (removed.some((r) => state.failDelete.has(String(r.id)))) return { data: null, error: { message: "canceling statement due to statement timeout" } };
        state.tables[this.table] = kept;
        return { data: removed, error: null };
      }
      const hit = rows.filter((r) => this.matches(r)).map((r) => ({ ...r }));
      return this.one ? { data: hit[0] ?? null, error: null } : { data: hit, error: null };
    }
  }

  return {
    state,
    requireAdmin: vi.fn(),
    db: {
      from: (t: string) => new Query(t),
      rpc: async (name: string, params: unknown) => {
        state.rpcCalls.push({ name, params });
        return state.rpc(name, params);
      },
    },
  };
});

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => m.db }));
vi.mock("@/lib/auth/admin", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/admin")>()),
  requireAdmin: m.requireAdmin,
}));
vi.mock("@/lib/ingest", () => ({ reingestDocument: vi.fn(async () => ({ chunks: 0 })) }));
vi.mock("@/lib/embeddings", () => ({ embed: vi.fn(async () => []) }));

import { PATCH as bulkPatch, DELETE as bulkDelete } from "@/app/api/admin/knowledge/objects/route";
import { PATCH as singlePatch } from "@/app/api/admin/knowledge/objects/[id]/route";
import { POST as entitiesPost, DELETE as entitiesDelete } from "@/app/api/admin/knowledge/entities/route";
import { AdminAuthError } from "@/lib/auth/admin";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const docId = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const MARKDOWN = "---\nid: PB-001\nstatus: active\n---\n\n# Pricing playbook\n\n## Summary\n\nAnchor high, then trade.\n";

function object(n: number, over: Record<string, unknown> = {}) {
  return {
    id: id(n),
    org_id: ORG,
    ref: `PB-${String(n).padStart(3, "0")}`,
    name: `Playbook ${n}`,
    intelligence_class: "playbook",
    domain: "sales",
    object_type: "framework",
    subtype: null,
    status: "active",
    priority: "normal",
    founder_endorsement: "approved",
    implementation_status: "not_tested",
    internal_validation: "unvalidated",
    evidence_level: null,
    authority: "B2",
    document_id: docId(n * 2),
    raw_document_id: docId(n * 2 + 1),
    compiled_markdown: MARKDOWN,
    version: 1,
    ...over,
  };
}

const eid = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function entity(n: number, over: Record<string, unknown> = {}) {
  return { id: eid(n), org_id: ORG, kind: "person", name: `Person ${n}`, slug: `person-${n}`, aliases: [], attributes: {}, mention_count: 1, ...over };
}

function req(method: string, body: unknown, url = "http://localhost/api/admin/knowledge/objects"): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const rows = (table: string) => m.state.tables[table] ?? [];
const obj = (n: number) => rows("knowledge_objects").find((o) => o.id === id(n));
/** Every recorded statement on a table carries an org_id = ORG filter. */
function expectOrgScoped(table: string) {
  const stmts = m.state.log.filter((s) => s.table === table && s.op !== "insert");
  expect(stmts.length).toBeGreaterThan(0);
  for (const s of stmts) expect(s.filters).toContainEqual({ col: "org_id", op: "eq", val: ORG });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.state.log = [];
  m.state.failUpdate = new Set();
  m.state.failDelete = new Set();
  m.state.rpcCalls = [];
  // Migration 0019 not applied: the merge falls back to its step-by-step path.
  m.state.rpc = () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.merge_entities" } });
  m.state.tables = {
    knowledge_objects: [object(1), object(2), object(3, { founder_endorsement: null, authority: "B3" }), object(9, { org_id: OTHER_ORG })],
    documents: [2, 3, 4, 5, 6, 7, 18, 19].map((n) => ({ id: docId(n), org_id: n >= 18 ? OTHER_ORG : ORG })),
    ingestion_decisions: [],
    chunks: [],
    entities: [
      entity(1, { name: "David Miller", aliases: [], mention_count: 3, attributes: { role: "closer" } }),
      entity(2, { name: "Dave Miller", aliases: ["DM", "david miller"], mention_count: 2, attributes: { team: "A", role: "setter" } }),
      entity(3, { name: "D. Miller", aliases: [], mention_count: 1 }),
      entity(9, { name: "Dave M", org_id: OTHER_ORG }),
    ],
    entity_mentions: [
      { id: "m1", org_id: ORG, entity_id: eid(1), object_id: id(1), document_id: null, role: "salesperson", value: null },
      { id: "m2", org_id: ORG, entity_id: eid(2), object_id: id(1), document_id: null, role: "salesperson", value: null },
      { id: "m3", org_id: ORG, entity_id: eid(2), object_id: id(2), document_id: null, role: "salesperson", value: null },
      { id: "m4", org_id: ORG, entity_id: eid(3), object_id: null, document_id: docId(4), role: null, value: "mentioned" },
      { id: "m9", org_id: OTHER_ORG, entity_id: eid(9), object_id: null, document_id: docId(18), role: null, value: null },
    ],
    metrics: [
      { id: "k1", org_id: ORG, entity_id: eid(2), metric_key: "close_rate" },
      { id: "k9", org_id: OTHER_ORG, entity_id: eid(9), metric_key: "close_rate" },
    ],
  };
  m.requireAdmin.mockResolvedValue({ userId: "u-1", orgId: ORG, email: "admin@practiscale.co", role: "admin", permissions: {}, memberId: "m-1" });
});

describe("PATCH /api/admin/knowledge/objects (bulk governance)", () => {
  it("requires documents:write", async () => {
    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Missing permission 'documents:write'", 403));
    const res = await bulkPatch(req("PATCH", { ids: [id(1)], patch: { status: "archived" } }));
    expect(res.status).toBe(403);
    expect(m.requireAdmin).toHaveBeenCalledWith("documents:write");
    expect(m.state.log).toHaveLength(0);
  });

  it("rejects an unauthenticated caller", async () => {
    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Not authenticated", 401));
    const res = await bulkPatch(req("PATCH", { ids: [id(1)], patch: { status: "archived" } }));
    expect(res.status).toBe(401);
  });

  it.each([
    ["no body", "not json"],
    ["missing ids", { patch: { status: "archived" } }],
    ["empty ids", { ids: [], patch: { status: "archived" } }],
    ["non-uuid id", { ids: [id(1), "1 or 1=1"], patch: { status: "archived" } }],
    ["more than 200 ids", { ids: Array.from({ length: 201 }, (_, i) => id(i + 1)), patch: { status: "archived" } }],
    ["nothing to change", { ids: [id(1)], patch: {} }],
    ["an unknown status", { ids: [id(1)], patch: { status: "deleted" } }],
    ["only non-governance fields", { ids: [id(1)], patch: { name: "Renamed", compiled_markdown: "# x" } }],
  ])("400s on %s", async (_label, body) => {
    const res = await bulkPatch(req("PATCH", body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toEqual(expect.any(String));
    expect(m.state.log).toHaveLength(0);
  });

  it("archives many objects with the single-object side effects, org-scoped", async () => {
    const res = await bulkPatch(req("PATCH", { ids: [id(1), id(2), id(1)], patch: { status: "archived" } }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect([...json.updated].sort()).toEqual([id(1), id(2)]);
    expect(json.failed).toEqual([]);
    expect(json.remaining).toEqual([]);
    // Authority recomputed (archived → C3) and the frontmatter rebuilt from the new metadata.
    for (const n of [1, 2]) {
      expect(obj(n)).toMatchObject({ status: "archived", authority: "C3" });
      expect(String(obj(n)?.compiled_markdown)).toContain("status: archived");
      expect(String(obj(n)?.compiled_markdown)).toContain("authority: C3");
    }
    expect(json.objects).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: id(1), status: "archived", authority: "C3" })])
    );
    // One decision per object, attributed to the admin.
    const decisions = rows("ingestion_decisions");
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({ org_id: ORG, stage: "persist", decision: "governance_edited", output: { by: "admin@practiscale.co" } });
    // Untouched rows stay untouched.
    expect(obj(3)).toMatchObject({ status: "active" });
    expectOrgScoped("knowledge_objects");
  });

  it("clears an endorsement with null and recomputes authority", async () => {
    const res = await bulkPatch(req("PATCH", { ids: [id(1)], patch: { founder_endorsement: null } }));
    expect(res.status).toBe(200);
    expect(obj(1)).toMatchObject({ founder_endorsement: null, authority: "B3" });
  });

  it("stamps last_verified_at for verify_now without touching the markdown", async () => {
    const res = await bulkPatch(req("PATCH", { ids: [id(1)], patch: { verify_now: true } }));
    expect(res.status).toBe(200);
    expect(typeof obj(1)?.last_verified_at).toBe("string");
    expect(obj(1)?.compiled_markdown).toBe(MARKDOWN);
    const update = m.state.log.find((s) => s.table === "knowledge_objects" && s.op === "update");
    expect(Object.keys(update?.payload as object)).toEqual(["last_verified_at"]);
  });

  it("never touches another org's object and reports it as not found", async () => {
    const res = await bulkPatch(req("PATCH", { ids: [id(1), id(9), id(42)], patch: { status: "draft" } }));
    const json = await res.json();
    expect(json.updated).toEqual([id(1)]);
    expect(json.failed).toEqual(
      expect.arrayContaining([
        { id: id(9), error: "Not found", status: 404 },
        { id: id(42), error: "Not found", status: 404 },
      ])
    );
    expect(obj(9)).toMatchObject({ status: "active", org_id: OTHER_ORG });
    expectOrgScoped("knowledge_objects");
  });

  it("reports a failed update per object and still updates the rest", async () => {
    m.state.failUpdate.add(id(2));
    const res = await bulkPatch(req("PATCH", { ids: [id(1), id(2), id(3)], patch: { internal_validation: "validated" } }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect([...json.updated].sort()).toEqual([id(1), id(3)]);
    expect(json.failed).toEqual([{ id: id(2), error: "update exploded" }]);
    expect(obj(1)).toMatchObject({ internal_validation: "validated", authority: "B1" });
    expect(obj(2)).toMatchObject({ internal_validation: "unvalidated" });
  });

  it("hands back unstarted objects as remaining once the time budget is spent", async () => {
    let t = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      t += 50_000;
      return t;
    });
    let json: { updated: string[]; remaining: string[] };
    try {
      json = await (await bulkPatch(req("PATCH", { ids: [id(1), id(2), id(3)], patch: { status: "draft" } }))).json();
    } finally {
      clock.mockRestore();
    }
    expect(json.updated.length + json.remaining.length).toBe(3);
    expect(json.remaining.length).toBeGreaterThan(0);
    for (const r of json.remaining as string[]) expect(obj(Number(r.slice(-12)))?.status).toBe("active");
  });
});

describe("DELETE /api/admin/knowledge/objects (bulk delete)", () => {
  it("requires documents:write", async () => {
    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Missing permission 'documents:write'", 403));
    const res = await bulkDelete(req("DELETE", { ids: [id(1)] }));
    expect(res.status).toBe(403);
    expect(m.state.tables.knowledge_objects).toHaveLength(4);
  });

  it("400s on bad ids", async () => {
    expect((await bulkDelete(req("DELETE", { ids: "all" }))).status).toBe(400);
    expect((await bulkDelete(req("DELETE", { ids: ["x"] }))).status).toBe(400);
    expect(m.state.log).toHaveLength(0);
  });

  it("deletes the objects and their compiled + raw documents, only in the admin's org", async () => {
    const res = await bulkDelete(req("DELETE", { ids: [id(1), id(2), id(9), id(42)] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect([...json.deleted].sort()).toEqual([id(1), id(2)]);
    expect(json.deletedDocuments).toBe(4);
    expect(json.failed).toEqual(
      expect.arrayContaining([
        { id: id(9), error: "Not found", status: 404 },
        { id: id(42), error: "Not found", status: 404 },
      ])
    );
    expect(rows("knowledge_objects").map((o) => o.id).sort()).toEqual([id(3), id(9)]);
    // Object 3's documents and the other org's documents survive.
    expect(rows("documents").map((d) => d.id).sort()).toEqual([docId(6), docId(7), docId(18), docId(19)]);
    expectOrgScoped("knowledge_objects");
    expectOrgScoped("documents");
  });

  it("deletes slice by slice: a failing slice is reported, earlier slices stay deleted, the next still runs", async () => {
    // 120 objects = 3 slices of <=50; the second slice's documents fail to delete.
    const many = Array.from({ length: 120 }, (_, i) => 100 + i);
    m.state.tables.knowledge_objects.push(...many.map((n) => object(n)));
    m.state.tables.documents.push(...many.flatMap((n) => [n * 2, n * 2 + 1]).map((n) => ({ id: docId(n), org_id: ORG })));
    m.state.failDelete.add(docId(160 * 2)); // object 160 is in the second slice (objects 150..199)

    const res = await bulkDelete(req("DELETE", { ids: many.map(id) }));
    expect(res.status).toBe(200);
    const json = await res.json();
    const firstAndThird = [...many.slice(0, 50), ...many.slice(100)].map(id);
    const second = many.slice(50, 100).map(id);
    expect([...json.deleted].sort()).toEqual([...firstAndThird].sort());
    expect(json.deletedDocuments).toBe(140);
    expect(json.failed).toHaveLength(50);
    for (const f of json.failed) {
      expect(second).toContain(f.id);
      expect(f).toMatchObject({ status: 500, error: expect.stringContaining("statement timeout") });
    }
    // The failed slice's objects and documents are all still there (nothing half-deleted).
    for (const n of many.slice(50, 100)) {
      expect(obj(n)).toBeDefined();
      expect(rows("documents").some((d) => d.id === docId(n * 2))).toBe(true);
    }
    expect(obj(100)).toBeUndefined();
    expect(obj(219)).toBeUndefined();
    // Every statement's id list stays short enough for the URL.
    for (const s of m.state.log.filter((x) => x.op === "delete")) {
      const ids = s.filters.find((f) => f.op === "in")?.val as unknown[];
      expect(ids.length).toBeLessThanOrEqual(100);
    }
    expectOrgScoped("knowledge_objects");
    expectOrgScoped("documents");
  });
});

describe("PATCH /api/admin/knowledge/objects/[id] (single, shared governance)", () => {
  const ctx = (n: number) => ({ params: Promise.resolve({ id: id(n) }) });

  it("keeps its contract: { object, chunks } with authority and frontmatter kept in step", async () => {
    const res = await singlePatch(req("PATCH", { status: "historical", name: "Pricing (2024)" }, `http://localhost/api/admin/knowledge/objects/${id(1)}`), ctx(1));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.chunks).toBeNull();
    expect(json.object).toMatchObject({ id: id(1), status: "historical", authority: "C1", name: "Pricing (2024)" });
    expect(String(obj(1)?.compiled_markdown)).toContain("status: historical");
    expect(rows("ingestion_decisions")[0]).toMatchObject({ decision: "governance_edited", input: { fields: expect.arrayContaining(["status", "name", "authority", "compiled_markdown"]) } });
  });

  it("still honours an explicit authority over the recomputed one", async () => {
    await singlePatch(req("PATCH", { status: "archived", authority: "A1" }, `http://localhost/api/admin/knowledge/objects/${id(1)}`), ctx(1));
    expect(obj(1)).toMatchObject({ status: "archived", authority: "A1" });
  });

  it("404s for another org's object", async () => {
    const res = await singlePatch(req("PATCH", { status: "draft" }, `http://localhost/api/admin/knowledge/objects/${id(9)}`), ctx(9));
    expect(res.status).toBe(404);
    expect(obj(9)).toMatchObject({ status: "active" });
  });
});

const ENTITIES_URL = "http://localhost/api/admin/knowledge/entities";
const ent = (n: number) => rows("entities").find((e) => e.id === eid(n));

describe("POST /api/admin/knowledge/entities (merge)", () => {
  const merge = (body: unknown) => entitiesPost(req("POST", body, ENTITIES_URL));

  it("requires documents:write", async () => {
    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Missing permission 'documents:write'", 403));
    const res = await merge({ action: "merge", ids: [eid(2)], targetId: eid(1) });
    expect(res.status).toBe(403);
    expect(m.requireAdmin).toHaveBeenCalledWith("documents:write");
    expect(m.state.log).toHaveLength(0);
  });

  it.each([
    ["an unknown action", { action: "explode", ids: [eid(2)], targetId: eid(1) }],
    ["a missing target", { action: "merge", ids: [eid(2)] }],
    ["a non-uuid id", { action: "merge", ids: ["nope"], targetId: eid(1) }],
    ["more than 50 ids", { action: "merge", ids: Array.from({ length: 51 }, (_, i) => eid(i + 10)), targetId: eid(1) }],
    ["only the target itself", { action: "merge", ids: [eid(1)], targetId: eid(1) }],
  ])("400s on %s", async (_label, body) => {
    const res = await merge(body);
    expect(res.status).toBe(400);
    expect(m.state.log).toHaveLength(0);
  });

  it("404s when the target belongs to another org", async () => {
    const res = await merge({ action: "merge", ids: [eid(2)], targetId: eid(9) });
    expect(res.status).toBe(404);
    expect(ent(2)).toBeDefined();
  });

  it("folds entities into the target: mentions, metrics, aliases, counts; org-scoped", async () => {
    const res = await merge({ action: "merge", ids: [eid(1), eid(2), eid(3), eid(9), eid(42)], targetId: eid(1) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect([...json.merged].sort()).toEqual([eid(2), eid(3)]);
    expect(json.failed).toEqual(
      expect.arrayContaining([
        { id: eid(9), error: "Not found", status: 404 },
        { id: eid(42), error: "Not found", status: 404 },
      ])
    );
    expect(json.mentionsMoved).toBe(3);

    // Merged entities are gone; the other org's entity is untouched.
    expect(ent(2)).toBeUndefined();
    expect(ent(3)).toBeUndefined();
    expect(ent(9)).toMatchObject({ name: "Dave M", org_id: OTHER_ORG });

    // The target absorbed names (case-insensitively unique, never its own name), counts and attributes.
    expect(ent(1)).toMatchObject({
      aliases: ["Dave Miller", "DM", "D. Miller"],
      mention_count: 6,
      attributes: { team: "A", role: "closer" },
    });
    expect(json.entity).toMatchObject({ id: eid(1), mention_count: 6 });

    // Mentions now point at the target; the exact duplicate (same object + role) was dropped.
    const mentions = rows("entity_mentions");
    expect(mentions.map((x) => x.id).sort()).toEqual(["m1", "m3", "m4", "m9"]);
    expect(mentions.filter((x) => x.org_id === ORG).every((x) => x.entity_id === eid(1))).toBe(true);
    expect(mentions.find((x) => x.id === "m9")).toMatchObject({ entity_id: eid(9) });

    // Metrics follow the merge within the org only.
    expect(rows("metrics").find((x) => x.id === "k1")).toMatchObject({ entity_id: eid(1) });
    expect(rows("metrics").find((x) => x.id === "k9")).toMatchObject({ entity_id: eid(9) });

    expect(rows("ingestion_decisions")).toEqual([
      expect.objectContaining({ org_id: ORG, stage: "entities", decision: "entities_merged" }),
    ]);
    for (const table of ["entities", "entity_mentions", "metrics"]) expectOrgScoped(table);
  });
});

describe("POST /api/admin/knowledge/entities (merge in one transaction, migration 0019)", () => {
  const merge = (body: unknown) => entitiesPost(req("POST", body, ENTITIES_URL));
  const writes = (table: string) => m.state.log.filter((s) => s.table === table && s.op !== "select");

  it("runs steps 1-5 as one merge_entities call and reports its outcome", async () => {
    const after = { ...entity(1, { name: "David Miller" }), mention_count: 6 };
    m.state.rpc = (name) =>
      name === "merge_entities"
        ? { data: [{ merged: [eid(2), eid(3)], mentions_moved: 3, entity: after }], error: null }
        : { data: null, error: { message: "unexpected rpc" } };
    const res = await merge({ action: "merge", ids: [eid(2), eid(3), eid(9)], targetId: eid(1) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, merged: [eid(2), eid(3)], mentionsMoved: 3, entity: { id: eid(1), mention_count: 6 } });
    expect(json.failed).toEqual([{ id: eid(9), error: "Not found", status: 404 }]);

    expect(m.state.rpcCalls).toEqual([
      {
        name: "merge_entities",
        params: {
          p_org: ORG,
          p_target: eid(1),
          p_ids: [eid(2), eid(3)],
          p_aliases: ["Dave Miller", "DM", "D. Miller"],
          p_attributes: { team: "A", role: "closer" },
        },
      },
    ]);
    // No statement-by-statement writes: the function did all of them.
    expect(writes("entity_mentions")).toEqual([]);
    expect(writes("metrics")).toEqual([]);
    expect(writes("entities")).toEqual([]);
  });

  it("applies nothing when the transaction fails (a retry cannot double-count)", async () => {
    m.state.rpc = () => ({ data: null, error: { code: "40001", message: "could not serialize access" } });
    const res = await merge({ action: "merge", ids: [eid(2), eid(3)], targetId: eid(1) });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("could not serialize access");
    // No fallback to the step-by-step path after a real failure.
    expect(writes("entity_mentions")).toEqual([]);
    expect(writes("entities")).toEqual([]);
    expect(ent(2)).toBeDefined();
    expect(ent(1)).toMatchObject({ mention_count: 3 });
    expect(rows("ingestion_decisions")).toEqual([]);
  });
});

describe("DELETE /api/admin/knowledge/entities (bulk delete)", () => {
  it("requires documents:write", async () => {
    m.requireAdmin.mockRejectedValueOnce(new AdminAuthError("Missing permission 'documents:write'", 403));
    const res = await entitiesDelete(req("DELETE", { ids: [eid(2)] }, ENTITIES_URL));
    expect(res.status).toBe(403);
    expect(rows("entities")).toHaveLength(4);
  });

  it("400s on bad ids", async () => {
    expect((await entitiesDelete(req("DELETE", { ids: [] }, ENTITIES_URL))).status).toBe(400);
    expect((await entitiesDelete(req("DELETE", { ids: Array.from({ length: 201 }, (_, i) => eid(i + 10)) }, ENTITIES_URL))).status).toBe(400);
    expect(m.state.log).toHaveLength(0);
  });

  it("deletes only the admin's org entities and reports the rest", async () => {
    const res = await entitiesDelete(req("DELETE", { ids: [eid(2), eid(3), eid(9)] }, ENTITIES_URL));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect([...json.deleted].sort()).toEqual([eid(2), eid(3)]);
    expect(json.failed).toEqual([{ id: eid(9), error: "Not found", status: 404 }]);
    expect(rows("entities").map((e) => e.id).sort()).toEqual([eid(1), eid(9)]);
    expectOrgScoped("entities");
  });
});
