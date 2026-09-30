import { describe, it, expect, beforeEach, vi } from "vitest";

// Regression test for the notification-bell privilege leak (getAlerts).
//
// The bell (NotificationsBell) is rendered on every dashboard page and fires
// GET /api/admin/alerts for every signed-in member. Before the fix, getAlerts
// unconditionally returned data-source alerts ("Sync failed: <name>", "Connector
// overdue: <name>") and ingestion-run/health counts to ANY member — including a
// content_copywriter who has NO data_sources grant, leaking source names and sync
// health through a side channel while the Sources page + /api/admin/sources
// correctly 403 the same member.
//
// The fix gates each alert category by the caller's grants (server-side, via
// can()): source + failed-run alerts need data_sources:read, review-due/stale
// need documents:read, unowned-collections needs collections:read. super_admin
// bypasses via can(). This test pins that behaviour so it can't silently regress.

type Perm = Record<string, string[]>;
type Role = "admin" | "super_admin";
type Session = {
  userId: string;
  orgId: string;
  email: string;
  role: Role;
  permissions: Perm;
  memberId: string;
};

// A Supabase double that returns rows/counts which WOULD produce every alert
// category, so the only reason an alert is absent is the permission gate.
const SOURCES = [
  // errored last sync -> "Sync failed: Call-scoring feed"
  { id: "s1", name: "Call-scoring feed", is_active: true, last_status: "error", last_run_at: null, schedule_cron: "0 * * * *" },
  // scheduled but never run -> "Connector overdue: Docs connector"
  { id: "s2", name: "Docs connector", is_active: true, last_status: "ok", last_run_at: null, schedule_cron: "0 * * * *" },
];
const RESULTS: Record<string, { data?: unknown; count?: number; error: null }> = {
  data_sources: { data: SOURCES, error: null },
  documents: { count: 5, error: null }, // -> review-due AND stale
  collections: { count: 2, error: null }, // -> no-owner
  ingestion_runs: { count: 3, error: null }, // -> runs-failed
};

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      const value = RESULTS[table] ?? { data: [], count: 0, error: null };
      const exec = () => Promise.resolve(value);
      Object.assign(q, {
        select: chain,
        insert: chain,
        update: chain,
        upsert: chain,
        delete: chain,
        eq: chain,
        in: chain,
        is: chain,
        not: chain,
        gte: chain,
        lte: chain,
        gt: chain,
        lt: chain,
        order: chain,
        limit: chain,
        range: chain,
        single: exec,
        maybeSingle: exec,
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => exec().then(res, rej),
      });
      return q;
    },
  }),
}));

import { getAlerts } from "@/lib/alerts";

const ORG = "11111111-1111-4111-8111-111111111111";
const session = (role: Role, permissions: Perm = {}): Session => ({
  userId: "user-1",
  orgId: ORG,
  email: "member@practiscale.co",
  role,
  permissions,
  memberId: "member-1",
});

const idsOf = async (s: Session) => (await getAlerts(s)).map((a) => a.id);
const SOURCE_IDS = ["src-error-s1", "src-overdue-s2", "runs-failed"];
const DOC_IDS = ["review-due", "stale"];
const COLLECTION_IDS = ["no-owner"];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getAlerts gates each category by the caller's grants", () => {
  it("does NOT leak data-source alerts to a content_copywriter (no data_sources grant)", async () => {
    const ids = await idsOf(
      session("admin", { documents: ["read", "write"], collections: ["read", "write"], prompts: ["read"], analytics: ["read"] })
    );
    // The leak: no per-source alert and no failed-run alert.
    expect(ids.some((id) => id.startsWith("src-"))).toBe(false);
    expect(ids).not.toContain("runs-failed");
    // But the categories they CAN act on still show.
    expect(ids).toEqual(expect.arrayContaining([...DOC_IDS, ...COLLECTION_IDS]));
  });

  it("never returns a data-source NAME in the title for a member without data_sources:read", async () => {
    const alerts = await getAlerts(session("admin", { documents: ["read"] }));
    const titles = alerts.map((a) => a.title).join(" | ");
    expect(titles).not.toContain("Call-scoring feed");
    expect(titles).not.toContain("Docs connector");
    expect(titles).not.toMatch(/Sync failed|Connector overdue/);
  });

  it("returns the full set to a knowledge_uploader (data_sources:read + docs + collections)", async () => {
    const ids = await idsOf(
      session("admin", { documents: ["read", "write"], collections: ["read", "write"], data_sources: ["read"], analytics: ["read"] })
    );
    expect(ids).toEqual(expect.arrayContaining([...SOURCE_IDS, ...DOC_IDS, ...COLLECTION_IDS]));
  });

  it("shows source alerts to a data_sources reader but not doc/collection alerts", async () => {
    const ids = await idsOf(session("admin", { data_sources: ["read"] }));
    expect(ids).toEqual(expect.arrayContaining(SOURCE_IDS));
    expect(ids).not.toContain("review-due");
    expect(ids).not.toContain("stale");
    expect(ids).not.toContain("no-owner");
  });

  it("read is implied by write: a data_sources WRITER still sees source alerts", async () => {
    const ids = await idsOf(session("admin", { data_sources: ["write"] }));
    expect(ids).toEqual(expect.arrayContaining(SOURCE_IDS));
  });

  it("returns NO alerts to a member with only analytics (no gated category)", async () => {
    const ids = await idsOf(session("admin", { analytics: ["read"] }));
    expect(ids).toEqual([]);
  });

  it("returns every category to a super_admin (can() bypass)", async () => {
    const ids = await idsOf(session("super_admin"));
    expect(ids).toEqual(expect.arrayContaining([...SOURCE_IDS, ...DOC_IDS, ...COLLECTION_IDS]));
  });
});
