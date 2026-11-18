import { z } from "zod";
import { readLivePayroll } from "@/lib/connectors/payroll-live";
import { BUSINESS_TIME_ZONE, todayIn } from "@/lib/timezone";

const dayMs = 86_400_000;

export const weeklyReviewRequest = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  refreshGhl: z.boolean().optional(),
}).strict();

export function completedReviewWeek(from: string, now = new Date()) {
  const start = new Date(from + "T00:00:00Z");
  if (!Number.isFinite(+start) || start.toISOString().slice(0, 10) !== from || start.getUTCDay() !== 1) {
    return null;
  }
  const through = new Date(+start + 6 * dayMs).toISOString().slice(0, 10);
  if (through >= todayIn(BUSINESS_TIME_ZONE, now)) return null;
  return { from, through, timeZone: BUSINESS_TIME_ZONE };
}

const count = z.number().int().safe().nonnegative();
const money = z.number().int().safe();
const payrollPerformance = z.object({
  summary: z.object({
    closings: count, usd_minor: money, showed: count, happened: count, no_show: count,
    show_rate: z.number().min(0).max(1).nullable(), absent_shows: z.string().nullable(),
  }),
  sales: z.array(z.object({
    ticket: z.enum(["high_ticket", "low_ticket"]), usd_minor: money,
    recorded_date: z.string().nullable(), ticket_assumed: z.boolean().optional(),
  })),
  undated_entries: count,
});

export function summarizeWeeklyPayroll(source: Awaited<ReturnType<typeof readLivePayroll>>) {
  const { summary, sales, undated_entries } = payrollPerformance.parse(source.data);
  const totals = { high_ticket: { count: 0, usdMinor: 0 }, low_ticket: { count: 0, usdMinor: 0 } };
  let assumedTickets = 0;
  // The response may contain dated admin entries elsewhere in either touched
  // month. Use Payroll's UTC date semantics, matching its range summary.
  for (const sale of sales) {
    if (!sale.recorded_date) continue;
    if (!Number.isFinite(Date.parse(sale.recorded_date))) throw new Error("Invalid Payroll closing date");
    const day = sale.recorded_date.slice(0, 10);
    if (day < source.from || day > source.through) continue;
    totals[sale.ticket].count++;
    totals[sale.ticket].usdMinor += sale.usd_minor;
    if (sale.ticket_assumed) assumedTickets++;
  }
  const high = totals.high_ticket;
  const low = totals.low_ticket;
  if (high.count + low.count !== summary.closings || high.usdMinor + low.usdMinor !== summary.usd_minor) {
    throw new Error("Payroll weekly sales rows do not reconcile with the source summary");
  }
  const hasRulings = !summary.absent_shows;
  const unclassified = summary.happened - summary.showed - summary.no_show;
  const expectedRate = summary.happened ? summary.showed / summary.happened : null;
  if (hasRulings && (unclassified < 0 || (
    summary.show_rate !== null && (expectedRate === null || Math.abs(summary.show_rate - expectedRate) > 0.000001)
  ))) throw new Error("Payroll weekly meeting outcomes do not reconcile");
  return {
    closings: summary.closings, usdMinor: summary.usd_minor, high, low, assumedTickets,
    undatedEntries: undated_entries,
    reviewed: hasRulings ? {
      showed: summary.showed, elapsed: summary.happened, noShow: summary.no_show,
      unclassified, showRate: summary.show_rate,
    } : null,
    reviewWarning: summary.absent_shows,
    checkedAt: source.fetched_at,
    dateBasis: source.date_basis,
  };
}

export async function readWeeklyPayroll(from: string, through: string, email: string, signal: AbortSignal) {
  const source = await readLivePayroll("performance", email, from, through, signal);
  return summarizeWeeklyPayroll(source);
}
