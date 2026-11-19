import { z } from "zod";
import { detectConsultants, detectPracticeType, resolveDate, resolveDateRange, type ScorecardRow } from "@/lib/call-review";
import { needsSynthesis } from "@/lib/response-guidance";
import { localDate, todayIn } from "@/lib/timezone";

type Turn = { role: string; content: string; createdAt?: string };
type ComparisonRange = { from: string; through: string; closedOnly: boolean };
type Counts = { high: number; low: number };
type ScoringCounts = Counts & { unclassified: number };

const differenceFollowUp = /^(?:(?:and|so)\s+)?(?:(?:is|was) there (?:any |a )?(?:difference|gap)|what(?:['’]s| is) (?:the )?(?:difference|gap)|(?:do|did) (?:they|the totals) match|how (?:big|large) is the (?:difference|gap))(?: between (?:them|the two))?[?!.\s]*$/i;
const payrollPerformance = z.object({
  sales: z.array(z.object({
    ticket: z.enum(["high_ticket", "low_ticket"]),
    recorded_date: z.string().nullable(),
    ticket_assumed: z.boolean().optional(),
  })),
});

export function resolvePayrollScoringComparison(turns: readonly Turn[], timeZone: string, now = Date.now()):
  ComparisonRange | { clarification: string } | null {
  const requests = turns.filter(turn => turn.role === "user");
  const latest = requests.at(-1);
  if (!latest) return null;
  const followUp = differenceFollowUp.test(latest.content.trim());
  const request = followUp
    ? requests.slice(0, -1).reverse().find(turn => !differenceFollowUp.test(turn.content.trim()) && !/^(?:thanks|thank you|ok|okay|got it)[.!\s]*$/i.test(turn.content.trim()))
    : latest;
  if (!request) return null;
  const text = request.content;
  if (needsSynthesis(text) || !/\bpayroll\b/i.test(text) || !/\bcall[ -]scoring\b/i.test(text) ||
    !/\b(?:ht|high[ -]ticket)\b/i.test(text) || !/\b(?:lt|low[ -]ticket)\b/i.test(text) ||
    !/\b(?:compare|comparison|vs|versus|difference|gap|reconcile|match)\b/i.test(text) ||
    !/\b(?:calls?|closings?|closed)\b/i.test(text) ||
    /\b(?:commissions?|earnings?|salary|revenue|closed value)\b/i.test(text)) return null;
  const filters = text.replace(/\b(?:(?:sales )?payroll|call[ -]scoring(?: app)?)\b/gi, " ");
  if (/\b(?:ghl|go[ -]?high[ -]?level|teams?|consultants?|setters?|closers?|pending|not[ -]closed|lost|disqualified|hours?|minutes?|by each|(?:only|just) (?:my|our)|per (?:person|rep))\b/i.test(filters) ||
    detectPracticeType(filters) || detectConsultants(filters).length) {
    return { clarification: "This comparison supports workspace-wide HT/LT counts by date. I couldn’t apply the additional filters across both sources." };
  }

  const sentAt = Date.parse(request.createdAt ?? "");
  if (followUp && !Number.isFinite(sentAt) && !/\b20\d{2}\b/.test(text)) {
    return { clarification: "Which exact dates should I use for the Sales Payroll and Call Scoring comparison? The original request’s date isn’t available." };
  }
  const reference = Number.isFinite(sentAt) ? localDate(sentAt, timeZone) : todayIn(timeZone, now);
  const range = resolveDateRange(text, reference, timeZone);
  const day = range ? undefined : resolveDate(text, reference, timeZone);
  const dates = range ?? (day ? { from: day, to: day } : undefined);
  if (!dates) {
    return { clarification: "Which dates should I compare across Sales Payroll and Call Scoring?" };
  }
  return {
    from: dates.from,
    through: dates.to,
    closedOnly: /\b(?:closings?|closed|won)\b/i.test(text),
  };
}

export async function readPayrollScoringComparison(range: ComparisonRange, timeZone: string, readers: {
  payroll(): Promise<unknown>;
  scoring(): Promise<{ rows: readonly Pick<ScorecardRow, "outcome" | "closingType">[]; complete: boolean }>;
  signal: AbortSignal;
}) {
  const [payroll, scoring] = await Promise.allSettled([
    readers.payroll().then(data => {
      const { sales } = payrollPerformance.parse(data);
      return {
        high: sales.filter(row => row.ticket === "high_ticket").length,
        low: sales.filter(row => row.ticket === "low_ticket").length,
        undated: sales.filter(row => row.recorded_date === null).length,
        assumed: sales.filter(row => row.ticket_assumed).length,
      };
    }),
    readers.scoring().then(({ rows, complete }): ScoringCounts => {
      if (!complete) throw new Error("Incomplete Call Scoring roster");
      const selected = range.closedOnly ? rows.filter(row => row.outcome === "Closed") : rows;
      const high = selected.filter(row => row.closingType === "High Ticket").length;
      const low = selected.filter(row => row.closingType === "Low Ticket").length;
      return { high, low, unclassified: selected.length - high - low };
    }),
  ]);
  readers.signal.throwIfAborted();
  const pay = payroll.status === "fulfilled" ? payroll.value : undefined;
  const calls = scoring.status === "fulfilled" ? scoring.value : undefined;
  const difference = (a: number | undefined, b: number | undefined) =>
    a === undefined || b === undefined ? "—" : b > a ? "+" + (b - a) : String(b - a);
  const display = (label: string, a: number | undefined, b: number | undefined) =>
    `| ${label} | ${a ?? "Unavailable"} | ${b ?? "Unavailable"} | ${difference(a, b)} |`;
  const total = (counts: Counts | undefined) => counts && counts.high + counts.low;
  const payrollTotal = total(pay);
  const scoringTotal = total(calls);
  let summary = "A difference can only be verified when both source counts are available for the selected dates.";
  if (payrollTotal !== undefined && scoringTotal !== undefined) {
    const gap = Math.abs(scoringTotal - payrollTotal);
    summary = gap
      ? `Call Scoring has **${gap} ${scoringTotal > payrollTotal ? "more" : "fewer"} HT/LT ${gap === 1 ? "record" : "records"}** in total than Sales Payroll.`
      : "Both sources show the same combined HT/LT count.";
  }
  const scoringLabel = range.closedOnly ? "Call Scoring · calls marked CRM Closed" : "Call Scoring · tagged calls";
  return [
    `## HT/LT comparison · ${range.from} to ${range.through}`,
    summary,
    [
      `| Ticket type | Sales Payroll · recorded closings | ${scoringLabel} | Difference (Call Scoring − Payroll) |`,
      "| --- | ---: | ---: | ---: |",
      display("High ticket (HT)", pay?.high, calls?.high),
      display("Low ticket (LT)", pay?.low, calls?.low),
      display("Combined HT + LT", payrollTotal, scoringTotal),
    ].join("\n"),
    "Sales Payroll counts recorded deals. Call Scoring counts indexed call records on their actual call dates, so multiple calls can relate to one deal. " +
      (range.closedOnly ? "The Call Scoring column includes calls currently marked CRM Closed." : "The Call Scoring column includes all CRM statuses, including follow-ups.") +
      " The difference is between record counts.",
    pay?.undated ? `Payroll assigned ${pay.undated} ${pay.undated === 1 ? "deal" : "deals"} to the reporting month without an exact closing date.` : "",
    pay?.assumed ? `Payroll used a default ticket category for ${pay.assumed} ${pay.assumed === 1 ? "deal" : "deals"}.` : "",
    calls?.unclassified ? `The totals exclude ${calls.unclassified} Call Scoring ${calls.unclassified === 1 ? "record" : "records"} without an HT/LT classification.` : "",
    [
      pay ? "[Sales Payroll](https://payroll.practicescalingsystems.com/admin) (Payroll reporting dates)" : "",
      calls ? `[Call Scoring](https://scoring.practicescalingsystems.com/) (indexed roster, actual call dates, ${timeZone})` : "",
    ].filter(Boolean).join(" · "),
  ].filter(Boolean).join("\n\n");
}
