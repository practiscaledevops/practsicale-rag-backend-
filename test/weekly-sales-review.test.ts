import { describe, expect, it } from "vitest";
import { completedReviewWeek, summarizeWeeklyPayroll } from "@/lib/weekly-sales-review";

const payroll = {
  report: "performance", from: "2026-10-26", through: "2026-11-01",
  date_basis: "Payroll dashboard reporting dates", fetched_at: "2026-11-02T07:00:00Z",
  source: "Sales Payroll" as const, complete: true as const, warnings: [],
  data: {
    summary: { closings: 3, usd_minor: 22500, showed: 1, happened: 2, no_show: 0, show_rate: 0.5, absent_shows: null },
    sales: [
      { recorded_date: "2026-10-31T23:59:00Z", ticket: "high_ticket", usd_minor: 12500 },
      { recorded_date: "2026-11-01T00:01:00Z", ticket: "low_ticket", usd_minor: 2500 },
      { recorded_date: "2026-11-01T12:00:00Z", ticket: "high_ticket", usd_minor: 7500 },
      { recorded_date: "2026-10-25T12:00:00Z", ticket: "high_ticket", usd_minor: 99999 },
      { recorded_date: "2026-11-02T12:00:00Z", ticket: "high_ticket", usd_minor: 99999 },
    ],
    undated_entries: 1,
  },
};

describe("Weekly Sales Review Payroll contract", () => {
  it("accepts only completed Monday–Sunday business weeks, including month-end", () => {
    const now = new Date("2026-11-01T19:00:00Z");
    expect(completedReviewWeek("2026-10-26", now)).toEqual({
      from: "2026-10-26", through: "2026-11-01", timeZone: "Asia/Karachi",
    });
    expect(completedReviewWeek("2026-10-26", new Date(+now - 1))).toBeNull();
    for (const invalid of ["2026-10-27", "2026-11-02", "2026-02-30"]) {
      expect(completedReviewWeek(invalid, now)).toBeNull();
    }
  });

  it("reconciles both months and keeps undated entries and unclassified meetings separate", () => {
    expect(summarizeWeeklyPayroll(payroll)).toMatchObject({
      closings: 3, usdMinor: 22500, high: { count: 2, usdMinor: 20000 },
      low: { count: 1, usdMinor: 2500 }, undatedEntries: 1,
      reviewed: { showed: 1, elapsed: 2, noShow: 0, unclassified: 1, showRate: 0.5 },
    });
  });

  it("rejects inconsistent amounts and keeps missing outcomes unavailable", () => {
    const missing = structuredClone(payroll);
    Object.assign(missing.data.summary, { absent_shows: "No rulings for this period", show_rate: null });
    expect(summarizeWeeklyPayroll(missing).reviewed).toBeNull();
    missing.data.summary.usd_minor += 1;
    expect(() => summarizeWeeklyPayroll(missing)).toThrow(/do not reconcile/);
  });
});
