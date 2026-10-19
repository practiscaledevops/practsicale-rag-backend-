import { describeFilter, looksLikeReview, normalizeCallReportQuery, type ScorecardRow, type CallReviewFilter } from "@/lib/call-review";
import { consultantSummaryContext } from "@/lib/call-report-summary";

/** Plain operational reports use exact server rows, independent of the selected LLM. */
export function wantsStructuredCallReport(query: string): boolean {
  const q = normalizeCallReportQuery(query);
  return looksLikeReview(q) && /\b(calls?|report|consultant.wise|summary)\b/i.test(q) &&
    (/\b(check|report|list|show|give|fetch|pull|summary|summarize|summarise|how many|total)\b/i.test(q) || /^\s*(?:today|yesterday)(?:['’]?s)?\s+calls?\s*[?.!]?\s*$/i.test(q)) &&
    !/\b(why|coach|coaching|improve|recommend|critique|analy[sz]e|analysis|audit|write|draft|create|generate|script|post|content)\b/i.test(q);
}
const cell = (v: unknown) => String(v ?? "Unknown").replace(/[\r\n]/g, " ").replace(/\|/g, "\\|");
export function renderCallReport(rows: ScorecardRow[], filter: CallReviewFilter, timeZone: string, complete = true): string {
  const label = `${describeFilter(filter)} · ${timeZone}`;
  if (!complete) return `I couldn't verify the complete call roster for ${label} because the database read was incomplete. This does not mean there were zero calls. Please retry the report.`;
  if (!rows.length) return `No matching calls were found in the Brain for ${label}. This is a database lookup result; it does not prove that no calls exist in the scoring app or that synchronization has completed.`;
  const summary = consultantSummaryContext(rows).split("\n").filter(l => l.startsWith("|")).join("\n");
  return [
    `## Call report — ${label}`, `${rows.length} calls in the Brain's matching roster. Current CRM status and ticket classifications are shown separately from original call outcomes.`,
    "### Per-call details", "| Time | Consultant | Prospect | Practice | Call / Follow-up | Original Call Outcome | Current CRM Status | Closing Type | Score | Band | Duration |",
    "|---|---|---|---|---|---|---|---|---:|---|---:|",
    ...rows.map(r => `| ${[`${r.date}${r.time ? ` ${r.time}` : ""}`, r.consultant, r.prospect || "Unknown", r.practice || "Unknown", r.callSequence || "Unknown", r.originalOutcome || "Unknown", r.outcome || "Pending", r.closingType || "Unclassified", r.score == null ? "Unknown" : `${r.score}/100`, r.band || "Unknown", r.duration == null ? "Unknown" : `${r.duration} min`].map(cell).join(" | ")} |`),
    "", "### Consultant-wise Summary", summary, "",
    "Follow Ups = original Follow Up outcome, and can overlap any current CRM status. High/Low Ticket Closings require current CRM Closed status and that ticket classification. Pending is not a closing. Unknown call sequence is not assumed to be Call 1.",
    "\nSource: the Brain's structured call roster. Counts are computed by the server, not estimated from retrieved transcript excerpts.",
  ].join("\n");
}
