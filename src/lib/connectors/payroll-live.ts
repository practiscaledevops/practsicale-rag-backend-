import { z } from 'zod';
import { parseCallReviewFilter } from '@/lib/call-review';
import { todayIn } from '@/lib/timezone';

export const sourcePermissions = { performance: 'reporting.view', people: 'employees.view', teams: 'teams.view', closings: 'dashboard.view', activity: 'reporting.view', payroll: 'reporting.view', fines: 'fines_bonuses.view', bonuses: 'fines_bonuses.view', rules: 'pay_rules.view', attendance: 'attendance.view' } as const;
export type PayrollReport = keyof typeof sourcePermissions;
export function planPayrollReports(query: string, timeZone: string): { reports: PayrollReport[]; from: string; through: string; unsupported?: string } | null {
  const reports = new Set<PayrollReport>();
  const headcount = /\b(how many|number of|count|list|names|who|current|active)\b/i.test(query) && /\b(setters?|consultants?|closers?|employees?|people|staff)\b/i.test(query) && !/\b(closed|closings|sales|appointments|show[ -]?ups?|calls|dials)\b/i.test(query);
  if (headcount) reports.add('people');
  if (/\b(fines?|deductions?|penalt(?:y|ies))\b/i.test(query)) reports.add('fines');
  if (/\b(bonuses|bonus)\b/i.test(query)) reports.add('bonuses');
  if (/\b(pay rules?|payroll rules?|commission rules?|current rules?|pay policy)\b/i.test(query)) reports.add('rules');
  if (/\b(people|employees?|headcount|roster|positions?)\b/i.test(query)) reports.add('people');
  if (/\bteams?\b/i.test(query)) reports.add('teams');
  if (/\b(attendance|absent|lateness)\b/i.test(query)) reports.add('attendance');
  if (/\b(payroll cost|salaries|salary|payslips?|payroll report)\b/i.test(query)) reports.add('payroll');
  if (!headcount && /\b(setters?|appointments?|show[ -]?ups?|no[ -]?shows?|dials?)\b/i.test(query)) reports.add('activity');
  if (!headcount && /\b(sales|closings?|closed|consultants?|closers?)\b/i.test(query) && !/\b(call|transcript|scorecard)\b/i.test(query)) reports.add('closings');
  if (!headcount && /\b(show[ -]?ups?|no[ -]?shows?|appointments?|setters?|consultants?|closers?|niches?|taxonomy|show[ -]?rate|best team|team performance|ht|lt|high ticket|low ticket)\b/i.test(query) && !/\b(call|transcript|scorecard|dials?)\b/i.test(query)) {
    reports.delete('closings');reports.delete('activity');reports.delete('teams');reports.add('performance');
  }
  if (reports.delete('closings')) reports.add('performance');
  if(reports.has('performance')) reports.delete('teams');
  if (!reports.size) return null;
  const today = todayIn(timeZone);
  const filter = parseCallReviewFilter(query, { referenceDate: today, timeZone });
  const from = filter.dateFrom ?? filter.date ?? today.slice(0,7)+'-01';
  const through = filter.dateTo ?? filter.date ?? today;
  const unsupported = /\b(hours?|minutes?)\b/i.test(query) ? 'This Payroll report currently has calendar-day precision; an hourly total cannot be verified through this reader.' : undefined;
  return { reports: [...reports], from, through, unsupported };
}
const envelope = z.object({ report: z.string(), from: z.string(), through: z.string(), date_basis: z.string(), fetched_at: z.string(), source: z.literal('Sales Payroll'), complete: z.literal(true), warnings: z.array(z.string()), data: z.unknown() });
export async function readLivePayroll(report: PayrollReport, email: string, from: string, through: string, signal: AbortSignal) {
  const key = process.env.PAYROLL_BRIDGE_KEY;
  if (!key) throw new Error('Payroll live bridge not configured');
  const response = await fetch('https://payroll.practicescalingsystems.com/api/brain/reports', {
    method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    headers: { Authorization: 'Bearer '+key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, report, from, through }),
  });
  if (!response.ok) throw new Error('Payroll '+report+' unavailable or outside supported scope');
  const result = envelope.parse(await response.json());
  if (result.report !== report || result.from !== from || result.through !== through) throw new Error('Unexpected report scope');
  return result;
}

/** Same current Payroll reader as its dashboard; do not duplicate its pay rules. */
export function payrollTotalsFromLive(data: unknown) {
  const row = z.object({ ticket: z.enum(['high_ticket','low_ticket']), usd_minor: z.number().int().safe() });
  const result = z.object({ dated: z.array(row), undated: z.array(row) }).parse(data);
  const rows = [...result.dated, ...result.undated];
  const high = rows.filter(r => r.ticket === 'high_ticket'), low = rows.filter(r => r.ticket === 'low_ticket');
  const sum = (values: typeof rows) => values.reduce((s,r)=>s+r.usd_minor,0);
  return { closings: rows.length, usd_minor: sum(rows), high_ticket: high.length, low_ticket: low.length, high_usd_minor: sum(high), low_usd_minor: sum(low) };
}
