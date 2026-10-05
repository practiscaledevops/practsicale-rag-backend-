import { describe, it, expect, beforeEach, vi } from "vitest";

// The approver-gated "knowledge awaiting approval" alert in getAlerts.
//
// Only a caller who can approve (super_admin / documents:approve) sees it — an
// uploader with documents:write must NOT, since they can't act on it. The count
// query is only issued for an approver (deploy-safe: safeCount returns 0 if the
// table is missing pre-migration).

type Perm = Record<string, string[]>;
type Role = "admin" | "super_admin";
type Session = { userId: string; orgId: string; email: string; role: Role; permissions: Perm; memberId: string };

const RESULTS: Record<string, { data?: unknown; count?: number; error: null }> = {
  data_sources: { data: [], error: null },
  documents: { count: 0, error: null },
  collections: { count: 0, error: null },
  ingestion_runs: { count: 0, error: null },
  knowledge_submissions: { count: 4, error: null },
};

const queried: string[] = [];

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      queried.push(table);
      const q: Record<string, unknown> = {};
      const chain = () => q;
      const value = RESULTS[table] ?? { data: [], count: 0, error: null };
      const exec = () => Promise.resolve(value);
      Object.assign(q, {
        select: chain, insert: chain, update: chain, upsert: chain, delete: chain,
        eq: chain, in: chain, is: chain, not: chain, gte: chain, lte: chain, gt: chain, lt: chain,
        order: chain, limit: chain, range: chain,
        single: exec, maybeSingle: exec,
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => exec().then(res, rej),
      });
      return q;
    },
  }),
}));

import { getAlerts } from "@/lib/alerts";

const ORG = "11111111-1111-4111-8111-111111111111";
const session = (role: Role, permissions: Perm = {}): Session => ({
  userId: "u", orgId: ORG, email: "m@practiscale.co", role, permissions, memberId: "mem-1",
});
const idsOf = async (s: Session) => (await getAlerts(s)).map((a) => a.id);

beforeEach(() => {
  vi.clearAllMocks();
  queried.length = 0;
});

describe("getAlerts — knowledge approvals", () => {
  it("shows the alert to a super_admin", async () => {
    const alerts = await getAlerts(session("super_admin"));
    const a = alerts.find((x) => x.id === "knowledge-approvals");
    expect(a).toBeDefined();
    expect(a!.priority).toBe("warning");
    expect(a!.title).toContain("4 knowledge submissions awaiting approval");
    expect(a!.href).toBe("/dashboard/knowledge/approvals");
  });

  it("shows the alert to an approver (documents:approve)", async () => {
    expect(await idsOf(session("admin", { documents: ["approve"] }))).toContain("knowledge-approvals");
  });

  it("does NOT show it to a documents:write-only uploader, and never queries the table for them", async () => {
    const ids = await idsOf(session("admin", { documents: ["read", "write"] }));
    expect(ids).not.toContain("knowledge-approvals");
    expect(queried).not.toContain("knowledge_submissions");
  });

  it("does NOT show it to a read-only member", async () => {
    expect(await idsOf(session("admin", { documents: ["read"] }))).not.toContain("knowledge-approvals");
  });
});
