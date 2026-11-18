import { resolveDate, resolveDateRange } from "@/lib/call-review";
import { localDate, todayIn } from "@/lib/timezone";

type Source = "payroll" | "call-scoring" | "crm";
type Metric = "closings" | "show-rate" | "scored-calls";
type Range = { from: string; through: string };
type Team = { kind: "mine" } | { kind: "named"; name: string };
type Turn = { role: string; content: string; createdAt?: string };

export type ReportScope = {
  source: Source;
  metric: Metric;
  team: Team | null;
  range: Range;
  comparison?: Range;
};

export const reportSourceLabels: Record<Source, string> = {
  payroll: "Sales Payroll",
  "call-scoring": "Call Scoring",
  crm: "GoHighLevel",
};

const sourcePattern = /\b(sales payroll|payroll|call[ -]scoring(?: app)?|go[ -]?high[ -]?level|ghl|crm)\b/i;
const periodPattern = String.raw`(?:today|yesterday|(?:this|last|previous|prior) (?:week|month)|last \d{1,2} days?|\d{4}-\d{2}-\d{2}|(?:from|between) \d{4}-\d{2}-\d{2} (?:to|through|and) \d{4}-\d{2}-\d{2})`;
const periodOnly = new RegExp(`^(?:(?:and|now|what about|how about|same (?:for|on)|just|only) )?(${periodPattern})$`, "i");
const comparePeriod = new RegExp(`^compare(?: (?:it|that|these|those))? (?:with|to|against) (${periodPattern})$`, "i");
const useSource = new RegExp(`^(?:(?:now|and) )?(?:(?:use|in|from|switch to|what about) )?${sourcePattern.source}$`, "i");
const teamOnly = /^(?:(?:and|now|just|only|for|what about|how about) )*(my team|(?:team [\p{L}\d][\p{L}\d '-]{0,59})|all teams|company-wide)(?: only)?$/iu;
const metricPattern = /\b(scored calls|call scores|show[ -]rate|closings|closed sales|sales totals?)\b/i;
const acknowledgement = /^(?:thanks(?: a lot)?|thank you|got it|ok(?:ay)?|perfect)$/i;
const recalledScopeRequest = /\b(?:what did (?:we|i) (?:decide|choose|pick|agree|say)|what (?:was|were) (?:our|my|the) (?:scope|team|dates?|date range|reporting source)|remind me (?:of|about|what|which)|recap)\b/i;
const pastReference = /\b(?:earlier|before|last time|previous(?:ly)?|discussed|chose|picked|agreed on|again)\b/i;
const teamMention = /\b(team [\p{L}\p{N}][\p{L}\p{N} '’-]{0,59}?)(?=\s*(?:[,.;:!?]|$)|\s+(?:and|from|between|on|in|for|using|during|last|this|today|yesterday|\d{1,4}[-–—])\b)/iu;
const genericTopicWords = new Set(["the", "our", "about", "scope", "team", "date", "dates", "range", "reporting", "source",
  "discussed", "earlier", "previously", "before", "again", "please"]);
type RecalledScope = { source: Source; team: string; range: Range };
const formatter = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });
const periodMention = new RegExp(`\\b${periodPattern}\\b`, "i");

export function formatReportRange({ from, through }: Range): string {
  const start = new Date(from + "T00:00:00Z");
  const end = new Date(through + "T00:00:00Z");
  return from === through ? formatter.format(start) : formatter.formatRange(start, end);
}

function namedSource(text: string): Source | undefined {
  const match = sourcePattern.exec(text)?.[0].toLowerCase();
  if (!match) return undefined;
  if (match.includes("payroll")) return "payroll";
  return match.startsWith("call") ? "call-scoring" : "crm";
}

function rangeFrom(text: string, reference: string, timeZone: string): Range | undefined {
  if (/^(last|previous|prior) week$/i.test(text)) {
    const day = new Date(reference + "T00:00:00Z");
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7) - 7);
    const from = day.toISOString().slice(0, 10);
    day.setUTCDate(day.getUTCDate() + 6);
    return { from, through: day.toISOString().slice(0, 10) };
  }
  const range = resolveDateRange(text, reference, timeZone);
  if (range) return { from: range.from, through: range.to };
  if (/^(from|between) /i.test(text)) return undefined;
  const day = resolveDate(text, reference, timeZone);
  return day ? { from: day, through: day } : undefined;
}

function teamFrom(text: string): Team | null {
  if (/^my team$/i.test(text)) return { kind: "mine" };
  return /^team /i.test(text) ? { kind: "named", name: text } : null;
}

/** Keep a user-selected scope visible in a conversational recap. This is chat
 * attribution only: it does not request a report or authorize a source read. */
export function recallRequestedReportScope(query: string, prior: readonly Turn[], timeZone: string): RecalledScope | null {
  if (!recalledScopeRequest.test(query)) return null;
  if (periodMention.test(query) || /\b(?:instead|switch to|change (?:the|to)|only|json|don['’]t|do not|(?:use|for|with) team)\b/i.test(query)) return null;

  const topic = /\babout ([^.!?\n]+)/i.exec(query)?.[1] ?? "";
  if (!topic && !pastReference.test(query) && !/\b(?:scope|reporting source)\b/i.test(query)) return null;
  const terms = (topic.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(term => !genericTopicWords.has(term));
  const requestedSource = namedSource(query);
  if (!terms.length) {
    const { scope } = resolveReportFollowup(prior, timeZone);
    if (scope?.team?.kind === "named" && (!requestedSource || requestedSource === scope.source)) {
      return { source: scope.source, team: scope.team.name, range: scope.range };
    }
  }
  for (let index = prior.length - 1; index >= 0; index--) {
    const turn = prior[index];
    if (turn.role !== "user" || turn.content.length > 900) continue;
    const text = turn.content.trim().replace(/[?!.]+$/, "");
    // A later explicit source or scope correction may supersede an older
    // complete selection. Don't re-state the old scope in that case.
    const correction = text.replace(/^(?:actually|instead)[,\s]+/i, "").replace(/\s+instead$/i, "");
    if (useSource.test(correction) || teamOnly.test(correction) || periodOnly.test(correction)) return null;
    if (terms.length && !terms.every(term => text.toLowerCase().includes(term))) continue;
    if (!/\b(?:use|choose|pick|select|keep|show|give|check|review|run)\b/i.test(text) ||
      /\b(?:don['’]t|do not|avoid|exclude|except|instead of)\b/i.test(text)) continue;
    const sources = new Set([...text.matchAll(new RegExp(sourcePattern.source, "gi"))].map(match => namedSource(match[0])));
    const source = namedSource(text);
    const team = teamMention.exec(text)?.[1].trim();
    const timestamp = Date.parse(turn.createdAt ?? "");
    if (!team && source && /\binstead\b/i.test(text)) return null;
    if (!source || sources.size !== 1 || (requestedSource && source !== requestedSource) || !team) continue;
    const period = periodMention.exec(text)?.[0];
    const year = /\b20\d{2}\b/.exec(period ?? text)?.[0];
    if (!Number.isFinite(timestamp) && !year) continue;
    const reference = Number.isFinite(timestamp) ? localDate(timestamp, timeZone) : `${year}-01-01`;
    const calendarRange = period ? undefined : resolveDateRange(text, reference, timeZone);
    const range = calendarRange ? { from: calendarRange.from, through: calendarRange.to } : rangeFrom(period ?? text, reference, timeZone);
    if (range) return { source, team, range };
  }
  return null;
}

export function supplementRecalledReportScope(scope: RecalledScope, answer: string): string {
  const source = reportSourceLabels[scope.source];
  const text = answer.replace(/\bteam(?:\s*:\s*|\s+)["“]?/gi, "Team ").toLowerCase();
  const dates = resolveDateRange(answer, scope.range.from);
  const sameDates = dates ? dates.from === scope.range.from && dates.to === scope.range.through
    : scope.range.from === scope.range.through && resolveDate(answer, scope.range.from) === scope.range.from;
  const missing = [
    ...(!text.includes(scope.team.toLowerCase()) ? [scope.team] : []),
    ...(!sameDates || !text.includes(scope.range.through.slice(0, 4)) ? [formatReportRange(scope.range)] : []),
    ...(!text.includes(source.toLowerCase()) ? [source] : []),
  ];
  return missing.length ? `\n\nEarlier scope you chose: **${missing.join(" · ")}**.` : "";
}

function baseScope(text: string, periodText: string | undefined, reference: string, timeZone: string): ReportScope | null {
  const metricText = metricPattern.exec(text)?.[0].toLowerCase();
  if (!metricText || !periodText) return null;

  const metric: Metric = /^show/.test(metricText) ? "show-rate" : /^scored|^call scores/.test(metricText) ? "scored-calls" : "closings";
  const source = namedSource(text) ?? (metric === "scored-calls" ? "call-scoring" : undefined);
  const range = rangeFrom(periodText, reference, timeZone);
  if (!source || !range) return null;

  // Take over simple aggregate requests only. Existing paths keep detailed
  // requests, person/owner filters, and any selection we cannot represent.
  const remainder = text.replace(sourcePattern, "").replace(metricPattern, "").replace(periodText + "'s", "").replace(periodText + "’s", "").replace(periodText, "")
    .replace(/\b(show|give|tell|check|me|the|how many|how much|total|number of|what is|what are|from|for|in|on|our|do we have)\b/gi, " ")
    .replace(/\s+/g, " ").trim();
  if (remainder && !teamOnly.test(remainder)) return null;
  return { source, metric, team: teamFrom(remainder), range };
}

export function resolveReportFollowup(
  turns: readonly Turn[],
  timeZone: string,
  now: number = Date.now(),
): { scope: ReportScope | null; clarification?: string } {
  const currentDay = todayIn(timeZone, now);
  let scope: ReportScope | null = null;
  let clarification: string | undefined;
  let missingPeriodDate = false;
  let missingComparisonDate = false;
  const userTurns = turns.filter((turn) => turn.role === "user");

  // Rebuild from user turns only. Their send dates freeze relative periods
  // when a saved conversation is reopened on a different day.
  for (const [index, turn] of userTurns.entries()) {
    clarification = undefined;
    const text = turn.content.trim().replace(/[?!.]+$/, "").trim();
    if (acknowledgement.test(text)) {
      if (index === userTurns.length - 1) return { scope: null };
      continue;
    }
    const recordedDate = turn.createdAt && Number.isFinite(Date.parse(turn.createdAt))
      ? localDate(turn.createdAt, timeZone)
      : undefined;
    const reference = recordedDate ?? currentDay;
    const missingAnchor = (text: string | undefined) =>
      !recordedDate && index !== userTurns.length - 1 && /^(today|yesterday|this|last|previous|prior)\b/i.test(text ?? "");
    const comparison = comparePeriod.exec(text)?.[1];
    const period = periodOnly.exec(text)?.[1];
    const team = teamOnly.exec(text.replace(/ only$/i, ""))?.[1];
    const source = useSource.test(text) ? namedSource(text) : undefined;
    if (scope && (comparison || period || team || source)) {
      const anchor: ReportScope = scope;
      const range = period ? rangeFrom(period, reference, timeZone) : anchor.range;
      const compared = comparison ? rangeFrom(comparison, reference, timeZone) : period ? undefined : anchor.comparison;
      if (!range || (comparison && !compared)) {
        clarification = "Which dates should I use for this report?";
        continue;
      }
      if (period) {
        missingPeriodDate = missingAnchor(period);
        missingComparisonDate = false;
      }
      if (comparison) missingComparisonDate = missingAnchor(comparison);
      scope = {
        source: source ?? anchor.source,
        metric: anchor.metric,
        team: team ? teamFrom(team) : anchor.team,
        range,
        ...(compared ? { comparison: compared } : {}),
      };
      continue;
    }
    const periodText = periodMention.exec(text)?.[0];
    scope = baseScope(text, periodText, reference, timeZone);
    missingPeriodDate = scope !== null && missingAnchor(periodText);
    missingComparisonDate = false;
    if (!scope && /^(compare\b.*\b(?:week|month)|(?:(?:just|only) )?my team(?: only)?)$/i.test(text)) {
      clarification = "Which report should I use? Include the measure, source, and date range, for example “Show Payroll closings this week.”";
    }
  }
  if (scope && (missingPeriodDate || missingComparisonDate)) {
    return { scope: null, clarification: "I can see the earlier report request, but its original date is unavailable. Which exact dates should I use?" };
  }
  return { scope, clarification };
}
