import { describe, it, expect, vi } from "vitest";
import type { AdminSession } from "@/lib/auth/session";

// Access control for the graph/learning knowledge routes (group-2). The change:
// every READ GET (taxonomy, relationships, learning, decisions, metrics, overview)
// now requires "documents:read" — previously they used a bare guard(), so any
// active member could read the whole back office. The curate + authoring WRITES
// stay on "documents:write".
//
// These tests exercise the REAL guard chain (requireAdmin → hasPermission →
// hasAction): only getAdmin is mocked, so we feed a session and assert the
// genuine 401/403/200 outcome. The DB is a permissive in-memory stand-in that
// returns empty results, and the non-DB helpers each handler calls are stubbed,
// so an allowed request runs to a real 200 without touching the network.
//
// Non-negotiables proven here:
//   - a member without documents is 403 on every read GET;
//   - a WRITE-only member is 200 on every read GET (read is implied by write);
//   - a read-only member is 403 on every curate/authoring write (needs :write);
//   - a write-holder (and super_admin) is admitted to every write;
//   - super_admin passes everything; unauthenticated is 401.

const m = vi.hoisted(() => ({ getAdmin: vi.fn() }));

// Real requireAdmin/hasPermission; only getAdmin is faked.
vi.mock("@/lib/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/session")>()),
  getAdmin: m.getAdmin,
}));

// Permissive empty DB: every awaited query resolves to no rows / count 0, and
// single()/maybeSingle() to null. Self-contained so nothing outside the factory
// is referenced (vi.mock is hoisted).
vi.mock("@/lib/supabase", () => {
  interface Q {
    select: (...a: unknown[]) => Q;
    eq: (...a: unknown[]) => Q;
    neq: (...a: unknown[]) => Q;
    not: (...a: unknown[]) => Q;
    or: (...a: unknown[]) => Q;
    in: (...a: unknown[]) => Q;
    is: (...a: unknown[]) => Q;
    gte: (...a: unknown[]) => Q;
    lte: (...a: unknown[]) => Q;
    gt: (...a: unknown[]) => Q;
    lt: (...a: unknown[]) => Q;
    order: (...a: unknown[]) => Q;
    limit: (...a: unknown[]) => Q;
    range: (...a: unknown[]) => Q;
    update: (...a: unknown[]) => Q;
    insert: (...a: unknown[]) => Q;
    delete: (...a: unknown[]) => Q;
    upsert: (...a: unknown[]) => Q;
    contains: (...a: unknown[]) => Q;
    single: () => Promise<{ data: null; error: null }>;
    maybeSingle: () => Promise<{ data: null; error: null }>;
    then: (res: (v: { data: unknown[]; error: null; count: number }) => unknown, rej?: (e: unknown) => unknown) => Promise<unknown>;
  }
  const make = (): Q => {
    const q: Q = {
      select: () => q,
      eq: () => q,
      neq: () => q,
      not: () => q,
      or: () => q,
      in: () => q,
      is: () => q,
      gte: () => q,
      lte: () => q,
      gt: () => q,
      lt: () => q,
      order: () => q,
      limit: () => q,
      range: () => q,
      update: () => q,
      insert: () => q,
      delete: () => q,
      upsert: () => q,
      contains: () => q,
      single: async () => ({ data: null, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (res, rej) => Promise.resolve({ data: [] as unknown[], error: null, count: 0 }).then(res, rej),
    };
    return q;
  };
  return { supabaseAdmin: () => ({ from: () => make(), rpc: async () => ({ data: null, error: null }) }) };
});

// Stub the non-DB helpers each handler calls, so an allowed request reaches 200.
vi.mock("@/lib/knowledge-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/knowledge-store")>()),
  listTaxonomyValues: vi.fn(async () => []),
  ensureTaxonomyValue: vi.fn(async () => ({ created: true, value: "finance", id: "t1" })),
  getObjectByRef: vi.fn(async () => ({ id: "o1", ref: "R-1" })),
  upsertRelationship: vi.fn(async () => ({ id: "e1", status: "confirmed" })),
  logDecision: vi.fn(async () => {}),
}));
vi.mock("@/lib/performance-memory", async (orig) => ({
  ...(await orig<typeof import("@/lib/performance-memory")>()),
  listMetrics: vi.fn(async () => []),
  insertMetric: vi.fn(async () => ({ id: "metric-1" })),
}));
vi.mock("@/lib/learning-followup", () => ({
  listFollowupQueue: vi.fn(async () => []),
  loadFollowupContext: vi.fn(),
  attachEvidence: vi.fn(),
  ignoreFollowup: vi.fn(),
  computeResultFromEvidence: vi.fn(),
  resultRecordMarkdown: vi.fn(),
  metricsAfterObject: vi.fn(),
}));
vi.mock("@/lib/brain-overview", async (orig) => ({
  ...(await orig<typeof import("@/lib/brain-overview")>()),
  getBrainOverview: vi.fn(async () => ({ generatedAt: new Date().toISOString(), health: [] })),
}));
vi.mock("@/lib/knowledge-compiler", () => ({
  compileKnowledge: vi.fn(async () => ({ blocked: null, object: { id: "o1", ref: "X-1", name: "n" }, chunks: 0, log: [], documentId: null })),
}));
vi.mock("@/lib/settings", async (orig) => ({
  ...(await orig<typeof import("@/lib/settings")>()),
  loadSettings: vi.fn(async () => ({ settings: { intelligence: { classifyTier: "fast", compileTier: "fast" } }, updatedAt: null })),
}));
vi.mock("@/lib/ingest", () => ({ pdfToText: vi.fn(async () => "text") }));
vi.mock("@/lib/ingest-adapters/request", () => ({ handleExtractRequest: vi.fn(async () => Response.json({ ok: true })) }));
vi.mock("@/lib/long-source", () => ({ outlineLongSource: vi.fn(async () => ({ title: null, author: null, chapters: [], via: "fallback", model: null })) }));
vi.mock("@/lib/ingest-adapters/audio", () => ({ transcribeAudio: vi.fn(async () => ({ text: "hi" })), MAX_AUDIO_BYTES: 26_214_400 }));
vi.mock("@/lib/knowledge-uploads", () => {
  class UploadError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  }
  return {
    createUploadTarget: vi.fn(async () => ({ bucket: "b", path: "p", signedUrl: "u", token: "t" })),
    UploadError,
    MAX_STORAGE_UPLOAD_BYTES: 52_428_800,
  };
});
vi.mock("@/lib/call-score-metrics", () => ({ rebuildCallScoreMetrics: vi.fn(async () => ({ ok: true, entities: 0, metrics: 0 })) }));
vi.mock("@/lib/demo/mode", () => ({ isDemo: vi.fn(() => false) }));

import { GET as taxGet, POST as taxPost, PATCH as taxPatch } from "@/app/api/admin/knowledge/taxonomy/route";
import { GET as relGet, POST as relPost, PATCH as relPatch } from "@/app/api/admin/knowledge/relationships/route";
import { GET as learnGet, POST as learnPost, PATCH as learnPatch } from "@/app/api/admin/knowledge/learning/route";
import { GET as decGet } from "@/app/api/admin/knowledge/decisions/route";
import { GET as metGet, POST as metPost } from "@/app/api/admin/knowledge/metrics/route";
import { POST as rebuildPost } from "@/app/api/admin/knowledge/metrics/rebuild-calls/route";
import { GET as ovGet } from "@/app/api/admin/knowledge/overview/route";
import { POST as compilePost } from "@/app/api/admin/knowledge/compile/route";
import { POST as extractPost } from "@/app/api/admin/knowledge/extract/route";
import { POST as outlinePost } from "@/app/api/admin/knowledge/outline/route";
import { POST as voicePost } from "@/app/api/admin/knowledge/voice/route";
import { POST as uploadUrlPost } from "@/app/api/admin/knowledge/upload-url/route";

const ORG = "org-1";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function session(permissions: Record<string, string[]>, role: AdminSession["role"] = "admin"): AdminSession {
  return { userId: "u-1", orgId: ORG, email: "member@practiscale.co", role, permissions, memberId: "mem-1" };
}
const SUPER = session({}, "super_admin");
const WRITER = session({ documents: ["write"] }); // write only — read is implied
const READER = session({ documents: ["read"] }); // read only — no write
const NO_DOCS = session({ analytics: ["read"] }); // no documents grant at all

const url = (p: string) => `http://localhost/api/admin/knowledge/${p}`;
const get = (p: string) => new Request(url(p));
const jsonReq = (p: string, method: "POST" | "PATCH", body: unknown) =>
  new Request(url(p), { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The read GETs that must now require documents:read. */
const READ_GETS: { name: string; run: () => Promise<Response> }[] = [
  { name: "taxonomy", run: () => taxGet() },
  { name: "relationships", run: () => relGet(get("relationships")) },
  { name: "learning", run: () => learnGet(get("learning")) },
  { name: "decisions", run: () => decGet(get("decisions")) },
  { name: "metrics", run: () => metGet(get("metrics")) },
  { name: "overview", run: () => ovGet() },
];

/** The curate + authoring writes that must stay on documents:write. */
const WRITES: { name: string; run: () => Promise<Response> }[] = [
  { name: "taxonomy POST (create value)", run: () => taxPost(jsonReq("taxonomy", "POST", { kind: "domain", value: "Finance" })) },
  { name: "taxonomy PATCH (approve)", run: () => taxPatch(jsonReq("taxonomy", "PATCH", { id: uuid(1), action: "approve" })) },
  { name: "relationships POST (link)", run: () => relPost(jsonReq("relationships", "POST", { sourceRef: "A-1", targetRef: "B-1", type: "complements" })) },
  { name: "relationships PATCH (confirm)", run: () => relPatch(jsonReq("relationships", "PATCH", { id: uuid(1), action: "confirm" })) },
  { name: "learning POST (record)", run: () => learnPost(jsonReq("learning", "POST", { kind: "learning", title: "T", change: "C" })) },
  { name: "learning PATCH (validate)", run: () => learnPatch(jsonReq("learning", "PATCH", { id: uuid(1), action: "validate" })) },
  { name: "metrics POST (add metric)", run: () => metPost(jsonReq("metrics", "POST", { metricKey: "close_rate", value: 0.5 })) },
  { name: "metrics/rebuild-calls POST", run: () => rebuildPost() },
  { name: "compile POST (ingest)", run: () => compilePost(jsonReq("compile", "POST", { mode: "preview", class: "playbook", text: "hello world" })) },
  { name: "extract POST", run: () => extractPost(jsonReq("extract", "POST", { url: "https://example.com" })) },
  { name: "outline POST", run: () => outlinePost(jsonReq("outline", "POST", { candidates: [{ index: 0, text: "Chapter 1" }] })) },
  { name: "voice POST", run: () => voicePost(jsonReq("voice", "POST", {})) },
  { name: "upload-url POST", run: () => uploadUrlPost(jsonReq("upload-url", "POST", { name: "book.pdf", size: 1000 })) },
];

describe("read GETs require documents:read", () => {
  it.each(READ_GETS)("$name: 401 when unauthenticated", async ({ run }) => {
    m.getAdmin.mockResolvedValue(null);
    expect((await run()).status).toBe(401);
  });

  it.each(READ_GETS)("$name: 403 for a member without documents", async ({ run }) => {
    m.getAdmin.mockResolvedValue(NO_DOCS);
    expect((await run()).status).toBe(403);
  });

  it.each(READ_GETS)("$name: 200 for a read-only member", async ({ run }) => {
    m.getAdmin.mockResolvedValue(READER);
    expect((await run()).status).toBe(200);
  });

  it.each(READ_GETS)("$name: 200 for a write-only member (read implied by write)", async ({ run }) => {
    m.getAdmin.mockResolvedValue(WRITER);
    expect((await run()).status).toBe(200);
  });

  it.each(READ_GETS)("$name: 200 for a super admin", async ({ run }) => {
    m.getAdmin.mockResolvedValue(SUPER);
    expect((await run()).status).toBe(200);
  });
});

describe("curate + authoring writes require documents:write", () => {
  it.each(WRITES)("$name: 401 when unauthenticated", async ({ run }) => {
    m.getAdmin.mockResolvedValue(null);
    expect((await run()).status).toBe(401);
  });

  it.each(WRITES)("$name: 403 for a read-only member (read never implies write)", async ({ run }) => {
    m.getAdmin.mockResolvedValue(READER);
    expect((await run()).status).toBe(403);
  });

  it.each(WRITES)("$name: 403 for a member without documents", async ({ run }) => {
    m.getAdmin.mockResolvedValue(NO_DOCS);
    expect((await run()).status).toBe(403);
  });

  it.each(WRITES)("$name: admits a write-holder (guard passes — never 401/403)", async ({ run }) => {
    m.getAdmin.mockResolvedValue(WRITER);
    expect([401, 403]).not.toContain((await run()).status);
  });

  it.each(WRITES)("$name: admits a super admin", async ({ run }) => {
    m.getAdmin.mockResolvedValue(SUPER);
    expect([401, 403]).not.toContain((await run()).status);
  });
});
