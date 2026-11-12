import { describeFilter, looksLikeReview, normalizeCallReportQuery, isOperationalClientReport, isCallCountRequest, isCallReportCreationRequest, isCallReportFilterFollowUp, type ReviewHistoryTurn, type ScorecardRow, type CallReviewFilter } from "@/lib/call-review";
import { consultantSummaryContext } from "@/lib/call-report-summary";

/** Plain operational reports use exact server rows, independent of the selected LLM. */
export function wantsStructuredCallReport(query: string, history: ReviewHistoryTurn[] = []): boolean {
  const q = normalizeCallReportQuery(query);
  if (isOperationalClientReport(q)) return true;
  if (history.length && isCallReportFilterFollowUp(q)) {
    const users=history.filter(t=>t.role === "user");
    if (users.at(-1)?.content.trim() === query.trim()) users.pop();
    const prior=users.pop();
    if (prior && wantsStructuredCallReport(prior.content,users)) return true;
  }
  // "Summarize our services ... not a long report" is not a call roster.
  // Require an operational subject; generic summary/report verbs are insufficient.
  if (!/\b(calls?|closings?|consultants?)\b/i.test(q)) return false;
  return looksLikeReview(q) && /\b(calls?|closings?|report|consultant.wise|summary)\b/i.test(q) &&
    (isCallCountRequest(q) || /\b(check|report|list|show|give|fetch|pull|summary|summarize|summarise|how many|total)\b/i.test(q) || /^\s*(?:today|yesterday)(?:['’]?s)?\s+calls?\s*[?.!]?\s*$/i.test(q)) &&
    !/\b(why|coach|coaching|improve|recommend|critique|analy[sz]e|analysis|audit|write|draft|script|post|content)\b/i.test(q) &&
    (!/\b(create|generate)\b/i.test(q) || isCallReportCreationRequest(q));
}
const cell = (v: unknown) => String(v ?? "Unknown").replace(/[\r\n]/g, " ").replace(/\|/g, "\\|");
export function renderCallReport(rows: ScorecardRow[], filter: CallReviewFilter, timeZone: string, complete = true, undated = 0): string {
  const label = `${describeFilter(filter)} · ${timeZone}`;
  if (!complete) return `I couldn't verify the complete call roster for ${label} because the database read was incomplete. This does not mean there were zero calls. Please retry the report.`;
  if (filter.closingCountOnly) {
    const high = rows.filter(row => row.closingType === "High Ticket").length;
    const low = rows.filter(row => row.closingType === "Low Ticket").length;
    const unclassified = rows.length - high - low;
    const breakdown = [high + " high ticket", low + " low ticket"];
    if (unclassified) breakdown.push(unclassified + " unclassified");
    return [
      "**" + rows.length + " closed call records** (" + breakdown.join(", ") + ") · " + label + ".",
      "The scoring records don’t include deal amounts, so they can verify the count of closed calls only.",
      ...(undated ? [undated + " closed call records lack a recorded CRM outcome date and are excluded."] : []),
    ].join("\n\n");
  }
  const dateNote = filter.dateBasis === "outcome"
    ? `Dates are recorded CRM outcome-event dates for currently closed records. ${undated} otherwise matching closed call record(s) have no recorded outcome date and cannot be assigned to this period. Import/update dates are never used as closing dates.`
    : "Dates are actual call dates from the scoring app. Calls without an actual date are excluded from dated reports; import dates are not call dates.";
  if (!rows.length) return `No matching calls with a recorded ${filter.dateBasis === "outcome" ? "CRM outcome date" : "call date"} were found in the Brain for ${label}.\n\n${dateNote}\n\nThis is a database lookup result; it does not prove that synchronization has completed.`;
  const summary = consultantSummaryContext(rows).split("\n").filter(l => l.startsWith("|")).join("\n");
  const pending = rows.filter(row => row.indexingPending).length;
  return [
    `## Call report — ${label}`, `${rows.length} ${rows.length === 1 ? "call" : "calls"} in the Brain's matching roster. Current CRM status and ticket classifications are shown separately from original call outcomes.`,
    dateNote,
    ...(filter.dateBasis === "outcome" ? [`**Client names:** ${[...new Set(rows.map(r => cell(r.prospect || "Unknown")))].join(", ")}.`, "One row per call record; repeated calls to a client are not additional clients."] : []),
    ...(pending ? [`${pending} newly received ${pending === 1 ? "call is" : "calls are"} listed with live status and ticket fields. Full report and transcript analysis are still indexing; they are not yet ready for content analysis.`] : []),
    "### Consultant-wise Summary", summary, "",
    "### Per-call details", "| Call date | CRM outcome date | Consultant | Prospect | Practice | Call / Follow-up | Original Call Outcome | Current CRM Status | Closing Type | Score | Band | Duration |",
    "|---|---|---|---|---|---|---|---|---|---:|---|---:|",
    ...rows.map(r => `| ${[`${r.date}${r.time ? ` ${r.time}` : ""}`, r.outcomeAt || "Not recorded", r.consultant, r.prospect || "Unknown", r.practice || "Unknown", r.callSequence || "Unknown", r.originalOutcome || "Unknown", r.outcome || "Pending", r.closingType || "Unclassified", r.score == null ? "Unknown" : `${r.score}/100`, r.band || "Unknown", r.duration == null ? "Unknown" : `${r.duration} min`].map(cell).join(" | ")} |`),
    "",
    "Follow Ups = original Follow Up outcome, and can overlap any current CRM status. High/Low Ticket Closings require current CRM Closed status and that ticket classification. Pending is not a closing. Unknown call sequence is not assumed to be Call 1.",
    "\nSource: the Brain's structured call roster. Counts are computed by the server, not estimated from retrieved transcript excerpts.",
  ].join("\n");
}
