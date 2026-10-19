import type { ScorecardRow } from "./call-review";

export interface ConsultantCallSummary {
  consultant: string;
  totalCalls: number;
  followUps: number;
  highTicketClosings: number;
  lowTicketClosings: number;
  closed: number;
  notClosed: number;
  pending: number;
  disqualified: number;
  otherStatus: number;
  unclassifiedClosings: number;
}

const COUNT_KEYS = ["totalCalls", "followUps", "highTicketClosings", "lowTicketClosings", "closed", "notClosed", "pending", "disqualified", "otherStatus", "unclassifiedClosings"] as const;
const normalized = (value: string | null | undefined) => (value ?? "").toLowerCase().replace(/[\s_-]/g, "");
const empty = (consultant: string): ConsultantCallSummary => ({ consultant, totalCalls: 0, followUps: 0,
  highTicketClosings: 0, lowTicketClosings: 0, closed: 0, notClosed: 0, pending: 0,
  disqualified: 0, otherStatus: 0, unclassifiedClosings: 0 });

/** Input is the complete, one-row-per-call scorecard, never selected chunks or
 * the smaller set of transcripts that fit the model's deep-reading budget. */
export function summarizeConsultantCalls(scorecard: ScorecardRow[]): { consultants: ConsultantCallSummary[]; total: ConsultantCallSummary } {
  const groups = new Map<string, ConsultantCallSummary>();
  for (const call of scorecard) {
    const name = call.consultant.trim().replace(/\s+/g, " ") || "Unknown consultant";
    const key = call.consultantId ? `id:${call.consultantId}` : `name:${name.toLowerCase()}`;
    let row = groups.get(key);
    if (!row) { row = empty(name); groups.set(key, row); }
    row.totalCalls++;
    if (normalized(call.originalOutcome) === "followup") row.followUps++;
    const status = normalized(call.outcome) || "pending";
    if (status === "closed") {
      row.closed++;
      const ticket = normalized(call.closingType);
      if (ticket === "highticket") row.highTicketClosings++;
      else if (ticket === "lowticket") row.lowTicketClosings++;
      else row.unclassifiedClosings++;
    } else if (status === "notclosed") row.notClosed++;
    else if (status === "pending") row.pending++;
    else if (status === "disqualified") row.disqualified++;
    else row.otherStatus++;
  }
  const consultants = [...groups.values()].sort((a, b) => a.consultant.localeCompare(b.consultant));
  const total = empty("Total");
  for (const row of consultants) for (const key of COUNT_KEYS) total[key] += row[key];
  return { consultants, total };
}

/** A ready-to-copy table with exact counts and their definitions. */
export function consultantSummaryContext(scorecard: ScorecardRow[]): string {
  if (!scorecard.length) return "";
  const { consultants, total } = summarizeConsultantCalls(scorecard);
  const columns: Array<[string, keyof Omit<ConsultantCallSummary, "consultant">]> = [
    ["Total Calls", "totalCalls"], ["Follow Ups", "followUps"],
    ["High Ticket Closings", "highTicketClosings"], ["Low Ticket Closings", "lowTicketClosings"],
    ["Closed", "closed"], ["Not Closed", "notClosed"], ["Pending", "pending"],
  ];
  // Keep totals reconcilable without silently dropping additional CRM states or
  // confirmed closes whose ticket category has not yet been assigned.
  if (total.disqualified) columns.push(["Disqualified", "disqualified"]);
  if (total.otherStatus) columns.push(["Other Status", "otherStatus"]);
  if (total.unclassifiedClosings) columns.push(["Unclassified Closings", "unclassifiedClosings"]);
  const safeName = (name: string) => name.replace(/[\r\n]/g, " ").replace(/\|/g, "\\|");
  return [
    "CONSULTANT SUMMARY — computed by the server from the complete matching scorecard. In every call report include a separate Consultant-wise Summary table with these exact columns, rows and totals; do not recalculate from the selected transcript sample. Preserve the per-call detail table too unless the user asks for summary only.",
    "Definitions: Follow Ups counts original call outcome FOLLOW_UP, including calls subsequently marked Closed. It is not the count of Call 2+ conversations and overlaps CRM status counts. High/Low Ticket Closings count only current CRM Closed calls with the corresponding ticket category; Pending or Not Closed ticket classifications are not confirmed closings. Closed includes Unclassified closings. State these definitions briefly below the summary. Use the report's same date range, time zone and filters; cite supporting call evidence for each consultant row.",
    `| Consultant | ${columns.map(([label]) => label).join(" | ")} |`,
    `|---|${columns.map(() => "---:").join("|")}|`,
    ...[...consultants, total].map(row => `| ${safeName(row.consultant)} | ${columns.map(([, key]) => row[key]).join(" | ")} |`),
  ].join("\n");
}
