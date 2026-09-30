import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdminSession } from "@/lib/auth/session";

// Access enforcement for the ingestion / data-source admin routes (group-4).
//
// Unlike the bulk-shape tests (which mock requireAdmin and assert it was CALLED
// with a key), these exercise the REAL requireAdmin -> hasPermission -> hasAction
// chain: only getAdmin is mocked, so every assertion below proves the actual RBAC
// behaviour on these routes —
//   - read GETs need "<resource>:read", but WRITE implies read (a writer is never
//     locked out) and super_admin bypasses all;
//   - write / side-effect routes still REQUIRE ":write" (read alone is 403), i.e.
//     the read-implied-by-write change did not weaken writes;
//   - data_sources has NO delete action (none is invented here);
//   - /api/admin/alerts stays OPEN — any signed-in member passes, even with no
//     grants — because it feeds the global notifications bell.

const m = vi.hoisted(() => ({ getAdmin: vi.fn() }));

// Partial-mock: keep the REAL hasPermission (it delegates to hasAction), override
// only how the session is resolved.
vi.mock("@/lib/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/session")>()),
  getAdmin: m.getAdmin,
}));

// A harmless universal Supabase stub: every query resolves to empty data, so a
// handler that PASSES the guard runs on to a clean 200 / 404 / 400 instead of
// crashing. We only care here about whether the guard let the request through.
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from() {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      Object.assign(q, {
        select: chain,
        eq: chain,
        in: chain,
        is: chain,
        order: chain,
        limit: chain,
        insert: chain,
        update: chain,
        upsert: chain,
        delete: chain,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        single: () => Promise.resolve({ data: null, error: null }),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(res, rej),
      });
      return q;
    },
  }),
}));

// Stub every heavy side-effect library the routes call AFTER the guard — so a
// request that gets through the guard never runs a real LLM, connector, ingest or
// background job.
vi.mock("@/lib/connectors/pull", () => ({ runPull: vi.fn(), backfillTranscripts: vi.fn() }));
vi.mock("@/lib/connectors/repair-dates", () => ({ repairCallDates: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/ingest", () => ({ ingestOne: vi.fn(), pdfToText: vi.fn() }));
vi.mock("@/lib/jobs/engine", () => ({
  createJob: vi.fn(),
  planJob: vi.fn(),
  listJobs: vi.fn(async () => []),
  getJobWithTasks: vi.fn(async () => null),
}));
vi.mock("@/lib/jobs/handlers", () => ({ JOB_HANDLERS: {} }));
vi.mock("@/lib/jobs/dispatch", () => ({ dispatchJob: vi.fn() }));
vi.mock("@/lib/alerts", () => ({ getAlerts: vi.fn(async () => []) }));

import { GET as sourcesGet, POST as sourcesPost, PATCH as sourcesPatch } from "@/app/api/admin/sources/route";
import { PATCH as sourcePatch } from "@/app/api/admin/sources/[id]/route";
import { POST as sourceSync } from "@/app/api/admin/sources/[id]/sync/route";
import { POST as sourceBackfill } from "@/app/api/admin/sources/[id]/backfill-transcripts/route";
import { POST as repairPost } from "@/app/api/admin/repair-call-dates/route";
import { POST as uploadsPost } from "@/app/api/admin/uploads/route";
import { GET as runsGet } from "@/app/api/admin/runs/route";
import { GET as jobsGet, POST as jobsPost } from "@/app/api/admin/jobs/route";
import { GET as jobGet } from "@/app/api/admin/jobs/[id]/route";
import { GET as alertsGet } from "@/app/api/admin/alerts/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const SRC = "aaaaaaaa-0000-4000-8000-000000000001";

type Perms = Record<string, string[]>;
function session(role: "admin" | "super_admin", permissions: Perms): AdminSession {
  return { userId: "user-1", orgId: ORG, email: "member@practiscale.co", role, permissions, memberId: "member-1" };
}
// Subjects under test.
const NONE = () => session("admin", {});
const DS_READ = () => session("admin", { data_sources: ["read"] });
const DS_WRITE = () => session("admin", { data_sources: ["write"] }); // read implied by write
const DOC_READ = () => session("admin", { documents: ["read"] });
const DOC_WRITE = () => session("admin", { documents: ["write"] });
const SUPER = () => session("super_admin", {});

const as = (s: AdminSession) => m.getAdmin.mockResolvedValue(s);
const anon = () => m.getAdmin.mockResolvedValue(null);

function req(url: string, method = "GET", body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const notBlocked = (status: number) => status !== 401 && status !== 403;

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Read GETs — require "<resource>:read"; write implies read; super_admin passes.
// ---------------------------------------------------------------------------

describe("data_sources read GETs require data_sources:read", () => {
  it.each([
    ["GET /api/admin/sources", sourcesGet],
    ["GET /api/admin/runs", runsGet],
  ])("%s: 401 anon, 403 without read, 200 with read / write / super_admin", async (_label, handler) => {
    anon();
    expect((await handler()).status).toBe(401);
    as(NONE());
    expect((await handler()).status).toBe(403);
    as(DS_READ());
    expect((await handler()).status).toBe(200);
    as(DS_WRITE()); // read is implied by write — the writer is not locked out
    expect((await handler()).status).toBe(200);
    as(SUPER());
    expect((await handler()).status).toBe(200);
  });
});

describe("jobs read GETs require documents:read", () => {
  it("GET /api/admin/jobs: 401 anon, 403 without documents:read, 200 with read / write / super_admin", async () => {
    anon();
    expect((await jobsGet()).status).toBe(401);
    as(NONE());
    expect((await jobsGet()).status).toBe(403);
    as(DS_READ()); // a data_sources grant does not open the jobs list
    expect((await jobsGet()).status).toBe(403);
    as(DOC_READ());
    expect((await jobsGet()).status).toBe(200);
    as(DOC_WRITE()); // write implies read
    expect((await jobsGet()).status).toBe(200);
    as(SUPER());
    expect((await jobsGet()).status).toBe(200);
  });

  it("GET /api/admin/jobs/[id]: 403 without documents:read, guard passes (404) with read / super_admin", async () => {
    as(NONE());
    expect((await jobGet(req(`/api/admin/jobs/${SRC}`), idCtx(SRC))).status).toBe(403);
    as(DOC_READ());
    expect((await jobGet(req(`/api/admin/jobs/${SRC}`), idCtx(SRC))).status).toBe(404); // guard passed; job not found
    as(SUPER());
    expect((await jobGet(req(`/api/admin/jobs/${SRC}`), idCtx(SRC))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Write / side-effect routes — still REQUIRE ":write" (read is not enough).
// ---------------------------------------------------------------------------

describe("data_sources write & side-effect routes require data_sources:write (read alone is 403)", () => {
  const writeCalls: [string, () => Promise<Response>][] = [
    ["POST /api/admin/sources", () => sourcesPost(req("/api/admin/sources", "POST", {}))],
    ["PATCH /api/admin/sources (bulk pause/resume)", () => sourcesPatch(req("/api/admin/sources", "PATCH", { ids: [SRC], is_active: false }))],
    ["PATCH /api/admin/sources/[id]", () => sourcePatch(req(`/api/admin/sources/${SRC}`, "PATCH", {}), idCtx(SRC))],
    ["POST /api/admin/sources/[id]/sync", () => sourceSync(req(`/api/admin/sources/${SRC}/sync`, "POST"), idCtx(SRC))],
    ["POST /api/admin/sources/[id]/backfill-transcripts", () => sourceBackfill(req(`/api/admin/sources/${SRC}/backfill-transcripts`, "POST"), idCtx(SRC))],
    ["POST /api/admin/repair-call-dates", () => repairPost()],
  ];

  it.each(writeCalls)("%s: 401 anon, 403 for a read-only member, passes for a writer & super_admin", async (_label, call) => {
    anon();
    expect((await call()).status).toBe(401);
    as(DS_READ()); // read does NOT grant write
    expect((await call()).status).toBe(403);
    as(DS_WRITE());
    expect(notBlocked((await call()).status)).toBe(true);
    as(SUPER());
    expect(notBlocked((await call()).status)).toBe(true);
  });

  it("the bulk pause/resume PATCH curates (200) for a writer — a real success, not just non-403", async () => {
    as(DS_WRITE());
    const res = await sourcesPatch(req("/api/admin/sources", "PATCH", { ids: [SRC], is_active: false }));
    expect(res.status).toBe(200);
  });
});

describe("uploads POST requires documents:write", () => {
  const call = () => uploadsPost(req("/api/admin/uploads", "POST", { not: "multipart" }));

  it("401 anon, 403 with only documents:read, passes for a writer & super_admin", async () => {
    anon();
    expect((await call()).status).toBe(401);
    as(DOC_READ()); // reading documents does not grant upload
    expect((await call()).status).toBe(403);
    as(DOC_WRITE());
    expect(notBlocked((await call()).status)).toBe(true);
    as(SUPER());
    expect(notBlocked((await call()).status)).toBe(true);
  });
});

describe("jobs POST requires documents:write", () => {
  const call = () => jobsPost(req("/api/admin/jobs", "POST", {}));

  it("403 with only documents:read; guard passes for a writer & super_admin", async () => {
    as(DOC_READ());
    expect((await call()).status).toBe(403);
    as(DOC_WRITE());
    expect(notBlocked((await call()).status)).toBe(true);
    as(SUPER());
    expect(notBlocked((await call()).status)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Alerts — deliberately OPEN (feeds the global notifications bell on every page).
// ---------------------------------------------------------------------------

describe("GET /api/admin/alerts stays open (no resource key)", () => {
  it("401 anon, but 200 for any signed-in member — even one with no grants", async () => {
    anon();
    expect((await alertsGet()).status).toBe(401);
    as(NONE()); // no permissions at all
    expect((await alertsGet()).status).toBe(200);
    as(DS_READ());
    expect((await alertsGet()).status).toBe(200);
    as(SUPER());
    expect((await alertsGet()).status).toBe(200);
  });
});
