import { describe, it, expect, vi, beforeEach } from "vitest";

// The knowledge-approval flow end to end, with auth + the DB + the heavy ingest
// entry points (compileKnowledge / ingestOne) mocked, so nothing hits the network.
//
// The guarantee this pins:
//   - a NON-approver's commit (compile wizard, bulk upload, learning lab) writes a
//     PENDING submission and NEVER calls compileKnowledge / ingestOne — so no chunk,
//     document or knowledge_object is created;
//   - an APPROVER's commit ingests directly, as before;
//   - approve replays the commit exactly once and is idempotent (no double-ingest);
//   - reject marks the row and ingests nothing;
//   - a documents:write-only caller gets 403 on approve/reject (cannot self-approve);
//   - the submissions list is self-only for an uploader and whole-org for an approver.

import { hasAction } from "@/lib/auth/permissions";

type Row = Record<string, unknown>;
type Filter = { op: "eq" | "in"; col: string; val: unknown };
interface Stmt {
  table: string;
  kind: "select" | "insert" | "update";
  patch?: Row;
  rows?: Row[];
  filters: Filter[];
  returning: boolean;
  orderCol?: string;
  ascending?: boolean;
  limit?: number;
}
type DbError = { message: string; code?: string };

let autoId = 0;

const m = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  compileKnowledge: vi.fn(),
  ingestOne: vi.fn(),
  pdfToText: vi.fn(),
  session: null as unknown,
  tables: {} as Record<string, Row[]>,
  stmts: [] as Stmt[],
}));

vi.mock("@/lib/auth/admin", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/admin")>()),
  requireAdmin: m.requireAdmin,
}));
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => ({ from: (table: string) => builder(table) }) }));
vi.mock("@/lib/knowledge-compiler", () => ({ compileKnowledge: m.compileKnowledge }));
vi.mock("@/lib/ingest", () => ({ ingestOne: m.ingestOne, pdfToText: m.pdfToText }));
// The learning route pulls these in at import; stub them so importing the route is cheap.
vi.mock("@/lib/learning-followup", () => ({
  listFollowupQueue: vi.fn(async () => []),
  loadFollowupContext: vi.fn(),
  attachEvidence: vi.fn(),
  ignoreFollowup: vi.fn(),
  computeResultFromEvidence: vi.fn(),
  resultRecordMarkdown: vi.fn(),
  metricsAfterObject: vi.fn(),
}));
vi.mock("@/lib/settings", () => ({ loadSettings: vi.fn(async () => ({ settings: {} })) }));

import { AdminAuthError } from "@/lib/auth/admin";
import { POST as compilePost } from "@/app/api/admin/knowledge/compile/route";
import { POST as uploadsPost } from "@/app/api/admin/uploads/route";
import { POST as learningPost } from "@/app/api/admin/knowledge/learning/route";
import { GET as submissionsGet, POST as submissionsPost } from "@/app/api/admin/knowledge/submissions/route";

/** Minimal chainable PostgREST stand-in: insert (returns rows), update (patches + returns), select (filter/order/limit). */
function builder(table: string) {
  const s: Stmt = { table, kind: "select", filters: [], returning: false };
  const matches = (r: Row) => s.filters.every((f) => (f.op === "eq" ? r[f.col] === f.val : (f.val as unknown[]).includes(r[f.col])));
  const exec = (): { data: unknown; error: DbError | null } => {
    m.stmts.push(s);
    const tbl = (m.tables[table] ??= []);
    if (s.kind === "insert") {
      const inserted = (s.rows ?? []).map((r) => ({ id: `row-${++autoId}`, ...r }));
      tbl.push(...inserted);
      return { data: inserted, error: null };
    }
    let rows = tbl.filter(matches);
    if (s.kind === "update") {
      for (const r of rows) Object.assign(r, s.patch);
      return { data: s.returning ? rows.map((r) => ({ ...r })) : null, error: null };
    }
    if (s.orderCol) {
      rows = [...rows].sort((a, b) => {
        const av = String(a[s.orderCol!] ?? "");
        const bv = String(b[s.orderCol!] ?? "");
        return s.ascending ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (typeof s.limit === "number") rows = rows.slice(0, s.limit);
    return { data: rows.map((r) => ({ ...r })), error: null };
  };
  const single = () => {
    const { data, error } = exec();
    const arr = (data as Row[]) ?? [];
    return { data: arr[0] ?? null, error };
  };
  const b = {
    select: (_cols?: string) => {
      if (s.kind !== "select") s.returning = true;
      return b;
    },
    insert: (rows: Row | Row[]) => {
      s.kind = "insert";
      s.rows = Array.isArray(rows) ? rows : [rows];
      return b;
    },
    update: (patch: Row) => {
      s.kind = "update";
      s.patch = patch;
      return b;
    },
    eq: (col: string, val: unknown) => {
      s.filters.push({ op: "eq", col, val });
      return b;
    },
    in: (col: string, val: unknown[]) => {
      s.filters.push({ op: "in", col, val });
      return b;
    },
    order: (col: string, opts?: { ascending?: boolean }) => {
      s.orderCol = col;
      s.ascending = opts?.ascending ?? true;
      return b;
    },
    limit: (n: number) => {
      s.limit = n;
      return b;
    },
    single: () => Promise.resolve(single()),
    maybeSingle: () => Promise.resolve(single()),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(exec()).then(res, rej),
  };
  return b;
}

// --- sessions ---------------------------------------------------------------

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
type Perm = Record<string, string[]>;
const session = (role: "admin" | "super_admin", permissions: Perm, memberId: string) => ({
  userId: `u-${memberId}`,
  orgId: ORG,
  email: `${memberId}@practiscale.co`,
  role,
  permissions,
  memberId,
});
const UPLOADER = session("admin", { documents: ["read", "write"] }, "mem-uploader");
const APPROVER = session("admin", { documents: ["read", "write", "approve"] }, "mem-approver");
const SUPER = session("super_admin", {}, "mem-super");

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function jsonReq(url: string, body: unknown, method = "POST"): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  autoId = 0;
  m.stmts = [];
  m.tables = { knowledge_submissions: [], ingestion_runs: [] };
  m.session = null;
  // requireAdmin uses the REAL permission logic against the current session.
  m.requireAdmin.mockImplementation(async (key?: string) => {
    const sess = m.session as (typeof UPLOADER) | null;
    if (!sess) throw new AdminAuthError("Not authenticated", 401);
    if (key) {
      const [resource, action] = key.split(":");
      const ok = sess.role === "super_admin" || hasAction(sess.permissions, resource, action);
      if (!ok) throw new AdminAuthError(`Missing permission '${key}'`, 403);
    }
    return sess;
  });
  m.compileKnowledge.mockResolvedValue({
    blocked: null,
    object: { id: "obj-1", ref: "PB-001", name: "Thing" },
    target: null,
    documentId: "doc-1",
    rawDocumentId: null,
    chunks: 3,
    log: [],
  });
  m.ingestOne.mockResolvedValue({ documentId: "doc-9", chunks: 5, skipped: false });
  m.pdfToText.mockResolvedValue("");
});

const subs = () => m.tables.knowledge_submissions;
/** compileKnowledge calls made in COMMIT mode (the only ones that create live knowledge). */
const committedCalls = () => m.compileKnowledge.mock.calls.filter((c) => (c[1] as { mode?: string })?.mode === "commit");

// ---------------------------------------------------------------------------
// compile route intercept
// ---------------------------------------------------------------------------

describe("POST /api/admin/knowledge/compile — approval gate", () => {
  it("a non-approver's commit parks a PENDING submission and never ingests", async () => {
    m.session = UPLOADER;
    const res = await compilePost(jsonReq("/api/admin/knowledge/compile", { mode: "commit", class: "playbook", text: "a".repeat(80), title: "My note" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pending).toBe(true);
    expect(typeof json.submissionId).toBe("string");

    // The park recomputes the proposal in PREVIEW mode (writes nothing) so the stored
    // preview is authoritative, but it must NEVER call the compiler in COMMIT mode —
    // no chunk / document / knowledge_object is created for a non-approver.
    expect(committedCalls()).toHaveLength(0);
    // No ingestion_runs row for a parked submission.
    expect(m.tables.ingestion_runs).toHaveLength(0);
    expect(subs()).toHaveLength(1);
    const row = subs()[0];
    expect(row).toMatchObject({ org_id: ORG, submitted_by: "mem-uploader", status: "pending", kind: "paste", commit_via: "compile", intelligence_class: "playbook" });
    expect((row.payload as { text: string }).text.length).toBeGreaterThan(50);
  });

  it("an approver's commit ingests directly (no submission)", async () => {
    m.session = APPROVER;
    const res = await compilePost(jsonReq("/api/admin/knowledge/compile", { mode: "commit", class: "playbook", text: "a".repeat(80), title: "T" }));
    expect(res.status).toBe(200);
    expect(m.compileKnowledge).toHaveBeenCalledTimes(1);
    expect(subs()).toHaveLength(0);
  });

  it("a super_admin's commit ingests directly (no submission)", async () => {
    m.session = SUPER;
    await compilePost(jsonReq("/api/admin/knowledge/compile", { mode: "commit", class: "playbook", text: "a".repeat(80), title: "T" }));
    expect(m.compileKnowledge).toHaveBeenCalledTimes(1);
    expect(subs()).toHaveLength(0);
  });

  it("PREVIEW still runs for a non-approver (nothing is written)", async () => {
    m.session = UPLOADER;
    const res = await compilePost(jsonReq("/api/admin/knowledge/compile", { mode: "preview", class: "playbook", text: "a".repeat(80) }));
    expect(res.status).toBe(200);
    expect(m.compileKnowledge).toHaveBeenCalledTimes(1);
    expect(subs()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// bulk upload route intercept
// ---------------------------------------------------------------------------

function uploadReq(text: string, name = "note.txt"): Request {
  const fd = new FormData();
  fd.append("file", new File([text], name, { type: "text/plain" }));
  return new Request("http://localhost/api/admin/uploads", { method: "POST", body: fd });
}

describe("POST /api/admin/uploads — approval gate", () => {
  it("a non-approver's upload parks a bulk submission and never ingests", async () => {
    m.session = UPLOADER;
    const res = await uploadsPost(uploadReq("hello world, enough text to ingest"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pending).toBe(true);
    expect(m.ingestOne).not.toHaveBeenCalled();
    expect(m.tables.ingestion_runs).toHaveLength(0);
    expect(subs()).toHaveLength(1);
    expect(subs()[0]).toMatchObject({ org_id: ORG, submitted_by: "mem-uploader", status: "pending", kind: "bulk", commit_via: "ingest_one", source_type: "document" });
    expect((subs()[0].payload as { sourceType: string }).sourceType).toBe("document");
  });

  it("an approver's upload ingests directly (no submission)", async () => {
    m.session = APPROVER;
    const res = await uploadsPost(uploadReq("hello world, enough text to ingest"));
    expect(res.status).toBe(200);
    expect(m.ingestOne).toHaveBeenCalledTimes(1);
    expect(subs()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// learning route intercept (manual record branch)
// ---------------------------------------------------------------------------

describe("POST /api/admin/knowledge/learning — approval gate", () => {
  it("a non-approver's manual record parks a learning submission and never ingests", async () => {
    m.session = UPLOADER;
    const res = await learningPost(jsonReq("/api/admin/knowledge/learning", { title: "We tried X", change: "changed the hook" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pending).toBe(true);
    expect(m.compileKnowledge).not.toHaveBeenCalled();
    expect(subs()).toHaveLength(1);
    expect(subs()[0]).toMatchObject({ kind: "learning", commit_via: "compile", intelligence_class: "organizational_learning", status: "pending" });
  });

  it("an approver's manual record ingests directly (no submission)", async () => {
    m.session = APPROVER;
    const res = await learningPost(jsonReq("/api/admin/knowledge/learning", { title: "We tried X", change: "changed the hook" }));
    expect(res.status).toBe(200);
    expect(m.compileKnowledge).toHaveBeenCalledTimes(1);
    expect(subs()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// submissions list (GET) — scope
// ---------------------------------------------------------------------------

function seedSubmission(over: Partial<Row>): Row {
  const row: Row = {
    id: over.id ?? `seed-${++autoId}`,
    org_id: ORG,
    submitted_by: "mem-uploader",
    submitted_by_email: "mem-uploader@practiscale.co",
    title: "x",
    kind: "paste",
    commit_via: "compile",
    source_type: null,
    intelligence_class: "playbook",
    bucket: null,
    payload: { intelligenceClass: "playbook", text: "t", title: "x" },
    preview: null,
    status: "pending",
    review_note: null,
    reviewed_by: null,
    reviewed_at: null,
    committed_object_id: null,
    storage_path: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
  (m.tables.knowledge_submissions ??= []).push(row);
  return row;
}

describe("GET /api/admin/knowledge/submissions — scope", () => {
  beforeEach(() => {
    seedSubmission({ id: U(1), submitted_by: "mem-uploader", status: "pending", created_at: "2026-01-01T00:00:01Z" });
    seedSubmission({ id: U(2), submitted_by: "mem-other", status: "pending", created_at: "2026-01-01T00:00:02Z" });
    seedSubmission({ id: U(3), submitted_by: "mem-uploader", status: "approved", created_at: "2026-01-01T00:00:03Z" });
    seedSubmission({ id: U(9), org_id: OTHER_ORG, submitted_by: "mem-uploader", status: "pending" });
  });

  it("an uploader sees ONLY their own submissions", async () => {
    m.session = UPLOADER;
    const res = await submissionsGet(new Request("http://localhost/api/admin/knowledge/submissions?status=pending"));
    const json = await res.json();
    expect(json.canApprove).toBe(false);
    expect(json.items.map((i: Row) => i.id)).toEqual([U(1)]); // own + pending, not the other member's, not the other org's
    expect(json.counts).toEqual({ pending: 1, approved: 1, rejected: 0 }); // own, across statuses
  });

  it("an approver sees the whole org's pending queue", async () => {
    m.session = APPROVER;
    const res = await submissionsGet(new Request("http://localhost/api/admin/knowledge/submissions?status=pending"));
    const json = await res.json();
    expect(json.canApprove).toBe(true);
    expect(json.items.map((i: Row) => i.id).sort()).toEqual([U(1), U(2)]); // both members, this org, not OTHER_ORG
    expect(json.counts).toEqual({ pending: 2, approved: 1, rejected: 0 });
  });
});

// ---------------------------------------------------------------------------
// approve / reject (POST) — authority + idempotency
// ---------------------------------------------------------------------------

describe("POST /api/admin/knowledge/submissions — approve / reject", () => {
  it("a documents:write-only caller gets 403 and nothing ingests (cannot self-approve)", async () => {
    const p = seedSubmission({ id: U(1), status: "pending" });
    m.session = UPLOADER;
    const res = await submissionsPost(jsonReq("/api/admin/knowledge/submissions", { id: U(1), action: "approve" }));
    expect(res.status).toBe(403);
    expect(m.compileKnowledge).not.toHaveBeenCalled();
    expect(p.status).toBe("pending");
  });

  it("an approver approves: replays compile ONCE, marks approved, records the object", async () => {
    const p = seedSubmission({ id: U(1), status: "pending", commit_via: "compile" });
    m.session = APPROVER;
    const res = await submissionsPost(jsonReq("/api/admin/knowledge/submissions", { id: U(1), action: "approve" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, status: "approved", committedObjectId: "obj-1" });
    expect(m.compileKnowledge).toHaveBeenCalledTimes(1);
    expect(p).toMatchObject({ status: "approved", reviewed_by: "mem-approver", committed_object_id: "obj-1" });
  });

  it("approve is idempotent: a second approve does NOT replay again", async () => {
    seedSubmission({ id: U(1), status: "pending", commit_via: "compile" });
    m.session = APPROVER;
    await submissionsPost(jsonReq("/api/admin/knowledge/submissions", { id: U(1), action: "approve" }));
    const res2 = await submissionsPost(jsonReq("/api/admin/knowledge/submissions", { id: U(1), action: "approve" }));
    expect(res2.status).toBe(200);
    expect((await res2.json()).alreadyApproved).toBe(true);
    expect(m.compileKnowledge).toHaveBeenCalledTimes(1);
  });

  it("approve dispatches ingestOne for a bulk submission", async () => {
    seedSubmission({
      id: U(2),
      status: "pending",
      kind: "bulk",
      commit_via: "ingest_one",
      source_type: "document",
      intelligence_class: null,
      payload: { sourceType: "document", title: "f.txt", text: "body", metadata: {}, collectionIds: undefined },
    });
    m.session = APPROVER;
    const res = await submissionsPost(jsonReq("/api/admin/knowledge/submissions", { id: U(2), action: "approve" }));
    expect(res.status).toBe(200);
    expect(m.ingestOne).toHaveBeenCalledTimes(1);
    expect(m.compileKnowledge).not.toHaveBeenCalled();
    expect((await res.json()).committedObjectId).toBe("doc-9");
  });

  it("reject marks the row with the note and ingests nothing", async () => {
    const p = seedSubmission({ id: U(3), status: "pending" });
    m.session = APPROVER;
    const res = await submissionsPost(jsonReq("/api/admin/knowledge/submissions", { id: U(3), action: "reject", note: "off brand" }));
    expect(res.status).toBe(200);
    expect(m.compileKnowledge).not.toHaveBeenCalled();
    expect(p).toMatchObject({ status: "rejected", review_note: "off brand", reviewed_by: "mem-approver" });
  });

  it("a documents:write-only caller gets 403 on reject too", async () => {
    seedSubmission({ id: U(4), status: "pending" });
    m.session = UPLOADER;
    expect((await submissionsPost(jsonReq("/api/admin/knowledge/submissions", { id: U(4), action: "reject" }))).status).toBe(403);
  });

  it("bulk approve replays each pending submission once", async () => {
    seedSubmission({ id: U(5), status: "pending", commit_via: "compile" });
    seedSubmission({ id: U(6), status: "pending", commit_via: "compile" });
    m.session = APPROVER;
    const res = await submissionsPost(jsonReq("/api/admin/knowledge/submissions", { ids: [U(5), U(6)], action: "approve" }));
    expect(res.status).toBe(200);
    expect((await res.json()).done.sort()).toEqual([U(5), U(6)]);
    expect(m.compileKnowledge).toHaveBeenCalledTimes(2);
  });

  it("bulk reject marks all pending rows rejected", async () => {
    const a = seedSubmission({ id: U(7), status: "pending" });
    const b = seedSubmission({ id: U(8), status: "pending" });
    m.session = APPROVER;
    const res = await submissionsPost(jsonReq("/api/admin/knowledge/submissions", { ids: [U(7), U(8)], action: "reject", note: "batch" }));
    expect(res.status).toBe(200);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(m.compileKnowledge).not.toHaveBeenCalled();
  });
});
