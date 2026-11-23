import { z } from 'zod';
import { parseCallReviewFilter } from '@/lib/call-review';
import { localDate, todayIn } from '@/lib/timezone';
import { requestedBusinessSource } from './business-followup';

export const sourcePermissions = { performance: 'reporting.view', people: 'employees.view', teams: 'teams.view', closings: 'dashboard.view', activity: 'reporting.view', payroll: 'reporting.view', ticket_commissions: 'reporting.view', fines: 'fines_bonuses.view', bonuses: 'fines_bonuses.view', rules: 'pay_rules.view', attendance: 'attendance.view' } as const;
export type PayrollReport = keyof typeof sourcePermissions;

const ticketType = /\b(ht|lt|high[ -]ticket|low[ -]ticket)\b/i;
const personalPay = /\b(earn(?:ed|s|ings?)?|commissions?|salary|salaries|payslips?|pay|paid)\b/i;

export function isPayrollTicketEarningsRequest(query: string): boolean {
  const task = query.split('Follow-up requested:').at(-1) ?? query;
  return ticketType.test(task) && personalPay.test(task) && !/\b(top|best|highest|most|rank(?:ing)?|leading)\b/i.test(task);
}

type TicketEarningsContext = {
  sentAt?: string;
  previousTurns: readonly { role: string; content: string; createdAt?: string }[];
};

function payrollReportDates(query: string, referenceDate: string, timeZone: string) {
  const filter = parseCallReviewFilter(query, { referenceDate, timeZone });
  const from = filter.dateFrom ?? filter.date;
  const through = filter.dateTo ?? filter.date;
  return from && through ? { from, through } : undefined;
}

function ticketEarningsDates(query: string, timeZone: string, context?: TicketEarningsContext) {
  const referenceDay = (createdAt: string | undefined) =>
    createdAt && Number.isFinite(Date.parse(createdAt)) ? localDate(createdAt, timeZone) : undefined;
  const day = referenceDay(context?.sentAt) ?? todayIn(timeZone);
  const explicit = payrollReportDates(query, day, timeZone);
  if (explicit) return explicit;

  const prior = context?.previousTurns.slice().reverse().find(turn => {
    if (turn.role !== 'user') return false;
    const source = requestedBusinessSource(turn.content);
    return (source === 'payroll' || source === null) &&
      (ticketType.test(turn.content) || personalPay.test(turn.content) || /\b(closings?|closed value|closed sales)\b/i.test(turn.content));
  });
  if (prior) {
    const priorDay = referenceDay(prior.createdAt);
    const dates = payrollReportDates(prior.content, priorDay ?? day, timeZone);
    if (dates) return dates;
    if (priorDay) return { from: priorDay.slice(0, 7) + '-01', through: priorDay };
  }
  return { from: day.slice(0, 7) + '-01', through: day };
}

export function planPayrollReports(query: string, timeZone: string, earningsContext?: TicketEarningsContext): { reports: PayrollReport[]; from: string; through: string; unsupported?: string } | null {
  if (isPayrollTicketEarningsRequest(query)) {
    return { reports: ['payroll'], ...ticketEarningsDates(query, timeZone, earningsContext) };
  }
  const reports = new Set<PayrollReport>();
  const headcount = !/\b(top|best|highest|ranking|rank|leading)\b/i.test(query) && /\b(how many|number of|count|list|names|who|current|active)\b/i.test(query) && /\b(setters?|consultants?|closers?|employees?|people|staff)\b/i.test(query) && !/\b(closed|closings|sales|appointments|show[ -]?rate|show[ -]?ups?|calls|dials)\b/i.test(query);
  if (headcount) reports.add('people');
  if (/\b(fines?|deductions?|penalt(?:y|ies))\b/i.test(query)) reports.add('fines');
  if (/\b(bonuses|bonus)\b/i.test(query)) reports.add('bonuses');
  if (/\b(pay rules?|payroll rules?|commission rules?|current rules?|pay policy)\b/i.test(query)) reports.add('rules');
  if (/\b(people|employees?|headcount|roster|positions?)\b/i.test(query)) reports.add('people');
  if (/\bteams?\b/i.test(query)) reports.add('teams');
  if (/\b(attendance|absent|lateness)\b/i.test(query)) reports.add('attendance');
  if (/\b(payroll cost|salaries|salary|payslips?|payroll report|earnings?|earning|earned|earns|commission)\b/i.test(query)) reports.add('payroll');
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
export class UnsupportedPayrollTicketReportError extends Error {}

export async function readLivePayroll(report: PayrollReport, email: string, from: string, through: string, signal: AbortSignal, person?: string) {
  const key = process.env.PAYROLL_BRIDGE_KEY;
  if (!key) throw new Error('Payroll live bridge not configured');
  const response = await fetch('https://payroll.practicescalingsystems.com/api/brain/reports', {
    method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    headers: { Authorization: 'Bearer '+key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, report, from, through, ...(person ? { person } : {}) }),
  });
  if (report === 'ticket_commissions' && response.status === 400) {
    throw new UnsupportedPayrollTicketReportError('Payroll does not support the requested ticket commission report');
  }
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
