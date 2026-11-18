import { afterEach, beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  requireSourcePermission: vi.fn(), readWeeklyPayroll: vi.fn(), appointmentSnapshotCounts: vi.fn(),
  readWeeklyCoaching: vi.fn(), payrollAccess: vi.fn(), resolveContext: vi.fn(),
}));

vi.mock("@/lib/auth/context", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/auth/context")>(), resolveContext: m.resolveContext,
}));
vi.mock("@/lib/connectors/payroll-report", () => ({ payrollAccess: m.payrollAccess }));
vi.mock("@/lib/connectors/source-access", () => ({ requireSourcePermission: m.requireSourcePermission }));
vi.mock("@/lib/connectors/appointment-snapshot", () => ({ appointmentSnapshotCounts: m.appointmentSnapshotCounts }));
vi.mock("@/lib/weekly-call-coaching", () => ({ readWeeklyCoaching: m.readWeeklyCoaching }));
vi.mock("@/lib/weekly-sales-review", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/weekly-sales-review")>(), readWeeklyPayroll: m.readWeeklyPayroll,
}));
vi.mock("@/lib/ratelimit", () => ({
  checkRateLimit: async () => ({ ok: true }), rateLimitHeaders: () => ({}),
}));

import { POST } from "@/app/api/v1/weekly-sales-review/route";

const key = { id: "app", capabilities: ["chat"], source_types: ["transcript"], data_source_ids: [], collection_ids: [] };
const report = (body: Record<string, unknown> = {}) => POST(new Request("https://example.test", {
  method: "POST", headers: { "x-chatbot-user-token": "verified-user-token" },
  body: JSON.stringify({ from: "2026-10-26", canReviewCalls: true, ...body }),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-18T00:00:00Z"));
  m.resolveContext.mockResolvedValue({ orgId: "org", key });
  m.payrollAccess.mockReturnValue(true);
  m.requireSourcePermission.mockResolvedValue("manager@example.test");
  m.readWeeklyPayroll.mockResolvedValue({ closings: 3 });
  m.appointmentSnapshotCounts.mockResolvedValue({ total: 9 });
  m.readWeeklyCoaching.mockResolvedValue({ calls: 5 });
});

afterEach(() => vi.useRealTimers());

it("uses Payroll dates, PKT appointment boundaries, and separate Call Scoring data", async () => {
  const res = await report();
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toContain("no-store");
  expect(m.requireSourcePermission).toHaveBeenCalledWith("verified-user-token", "reporting.view", expect.any(AbortSignal), { adminOnly: true });
  expect(m.readWeeklyPayroll).toHaveBeenCalledWith("2026-10-26", "2026-11-01", "manager@example.test", expect.any(AbortSignal));
  expect(m.appointmentSnapshotCounts).toHaveBeenCalledWith({
    start: "2026-10-25T19:00:00.000Z", end: "2026-11-01T19:00:00.000Z",
  }, expect.any(AbortSignal), undefined);
  expect(m.readWeeklyCoaching).toHaveBeenCalledWith("org", "2026-10-26", "2026-11-01", "Asia/Karachi", expect.any(AbortSignal));
  expect(await res.json()).toMatchObject({ payroll: { status: "ready" }, ghl: { status: "ready" }, scoring: { status: "ready" } });
});

it("denies access before any source is read", async () => {
  m.requireSourcePermission.mockRejectedValue(new Error("Access denied"));
  expect((await report()).status).toBe(403);
  expect(m.readWeeklyPayroll).not.toHaveBeenCalled();
  expect(m.appointmentSnapshotCounts).not.toHaveBeenCalled();
  expect(m.readWeeklyCoaching).not.toHaveBeenCalled();
});

it("returns the successful section when another source fails and will not broaden scoped keys", async () => {
  m.appointmentSnapshotCounts.mockRejectedValue(new Error("Timeout"));
  m.resolveContext.mockResolvedValue({ orgId: "org", key: { ...key, collection_ids: ["private-collection"] } });
  expect(await (await report()).json()).toMatchObject({
    payroll: { status: "ready", data: { closings: 3 } },
    ghl: { status: "unavailable" }, scoring: { status: "unavailable" },
  });
  expect(m.readWeeklyCoaching).not.toHaveBeenCalled();
});

it("refreshes only GHL so the caller can preserve Payroll and coaching evidence", async () => {
  expect(await (await report({ refreshGhl: true })).json()).toEqual({
    week: { from: "2026-10-26", through: "2026-11-01", timeZone: "Asia/Karachi" },
    ghl: { status: "ready", data: { total: 9 } },
  });
  expect(m.appointmentSnapshotCounts).toHaveBeenCalledWith(expect.anything(), expect.any(AbortSignal), true);
  expect(m.readWeeklyPayroll).not.toHaveBeenCalled();
  expect(m.readWeeklyCoaching).not.toHaveBeenCalled();
});
