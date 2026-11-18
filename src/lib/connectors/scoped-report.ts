import { z } from "zod";
import type { ScorecardRow } from "@/lib/call-review";
import { formatReportRange, reportSourceLabels, type ReportScope } from "./report-followup";

const payrollTotals = z.object({
  closings: z.number().int().nonnegative(),
  usd_minor: z.number().int().safe(),
  showed: z.number().int().nonnegative(),
  happened: z.number().int().nonnegative().optional(),
  show_rate: z.number().min(0).max(1).nullish(),
});
const payrollPerformance = z.object({
  summary: payrollTotals.extend({ absent_shows: z.string().nullable() }),
  teams: z.array(payrollTotals.extend({ label: z.string() })),
});

type Range = ReportScope["range"];
type PayrollReading = { data?: unknown; fetched_at: string };
type Readers = {
  payroll(range: Range): Promise<PayrollReading>;
  scoring(range: Range): Promise<{ rows: ScorecardRow[]; complete: boolean }>;
  demo?: boolean;
};
type Line = { label: string; values: string[] };
type ReportResult = {
  text: string;
  context?: { source: string; team: string; from: string; through: string; comparison?: Range; demo?: boolean };
};

const safe = (text: string) => text.replace(/[|<>\r\n]/g, " ").trim();
const teamKey = (text: string) => text.trim().replace(/^team\s+/i, "").replace(/\s+/g, " ").toLowerCase();
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export async function readScopedReport(scope: ReportScope, primaryTeam: string | undefined, readers: Readers): Promise<ReportResult> {
  const requestedTeam = scope.team?.kind === "mine" ? primaryTeam : scope.team?.name;
  if (scope.team?.kind === "mine" && !requestedTeam?.trim()) {
    return { text: "I couldn’t find a primary team on your AI Brain profile. Which team should I use? I’ll keep the report’s dates and source." };
  }
  if (scope.comparison?.from === scope.range.from && scope.comparison.through === scope.range.through) {
    return { text: "That’s the same date range as the current report. Which other dates should I compare it with?" };
  }
  const source = reportSourceLabels[scope.source];
  if (scope.source === "crm") {
    return { text: "The GoHighLevel reporting connection uses individual CRM owners. Give me the owner’s name to continue with a CRM lookup." };
  }
  if (scope.source === "call-scoring" && requestedTeam) {
    return { text: "I can keep Call Scoring and the selected dates, but its scorecard records don’t identify team membership. Which consultant’s scores should I check?" };
  }
  if ((scope.metric === "scored-calls") !== (scope.source === "call-scoring")) {
    return { text: `${source} can’t verify this measure. Which measure would you like from ${source}?` };
  }

  const ranges = scope.comparison ? [scope.range, scope.comparison] : [scope.range];
  let team = scope.source === "call-scoring" ? "All consultants" : "All teams";
  let lines: Line[];
  let checkedAt: string | undefined;
  if (scope.source === "payroll") {
    const readings = await Promise.all(ranges.map(readers.payroll));
    const reports = readings.map((reading) => payrollPerformance.parse(reading.data));
    const groups = reports.map((report) => {
      if (!requestedTeam) return report.summary;
      const matches = report.teams.filter((row) => teamKey(row.label) === teamKey(requestedTeam));
      return matches.length === 1 ? matches[0] : undefined;
    });
    const verified = groups.filter((group): group is NonNullable<typeof group> => !!group);
    if (verified.length !== reports.length) {
      return { text: `I couldn’t verify ${safe(requestedTeam ?? "that team")} in Sales Payroll for every selected period. Which Payroll team name should I use?` };
    }
    if (requestedTeam) team = reports[0].teams.find((row) => teamKey(row.label) === teamKey(requestedTeam))!.label;
    checkedAt = readings.map((reading) => reading.fetched_at).sort()[0];
    if (scope.metric === "show-rate") {
      if (reports.some((report) => report.summary.absent_shows) || verified.some((group) => group.show_rate == null || group.happened == null)) {
        return { text: "Sales Payroll couldn’t verify a show rate for every selected period. The comparison needs a verified rate for both periods." };
      }
      lines = [
        { label: "Reviewed show-ups", values: verified.map((group) => String(group.showed)) },
        { label: "Elapsed meetings", values: verified.map((group) => String(group.happened)) },
        { label: "Show rate", values: verified.map((group) => (group.show_rate! * 100).toFixed(1) + "%") },
      ];
    } else {
      lines = [
        { label: "Closings", values: verified.map((group) => String(group.closings)) },
        { label: "Closed amount (USD)", values: verified.map((group) => usd.format(group.usd_minor / 100)) },
      ];
    }
  } else {
    const readings = await Promise.all(ranges.map(readers.scoring));
    if (readings.some((reading) => !reading.complete)) throw new Error("Incomplete Call Scoring report");
    const scores = readings.map((reading) => reading.rows.flatMap((row) => row.score === null ? [] : [row.score]));
    lines = [
      { label: "Scored calls", values: scores.map((values) => String(values.length)) },
      { label: "Average score", values: scores.map((values) => values.length ? (values.reduce((sum, score) => sum + score, 0) / values.length).toFixed(1) : "Unavailable") },
    ];
  }
  const dims = safe(team);
  const headings = ["Measure", ...ranges.map(formatReportRange)];
  const headingsRow = `| ${headings.join(" | ")} |`;
  const separator = `| ${headings.map(() => "---").join(" | ")} |`;
  const rows = lines.map((line) => `| ${[line.label, ...line.values].join(" | ")} |`);
  const title = scope.metric === "closings" ? "Closings" : scope.metric === "show-rate" ? "Show rate" : "Call scores";
  const basis = scope.source === "payroll" ? "Payroll reporting dates (UTC)" : "Recorded call dates";
  const text = [
    `## ${title} · ${dims}`,
    readers.demo ? "Sample data from the local demo." : "",
    [headingsRow, separator, ...rows].join("\n"),
    `Source: ${source} · ${basis}.` + (checkedAt && !readers.demo ? ` Checked ${safe(checkedAt)}.` : ""),
    scope.comparison && (Date.parse(scope.range.through) - Date.parse(scope.range.from) !== Date.parse(scope.comparison.through) - Date.parse(scope.comparison.from))
      ? "These periods cover different numbers of days." : "",
  ].filter(Boolean).join("\n\n");
  return { text, context: { source, team: dims, ...scope.range, comparison: scope.comparison, demo: readers.demo } };
}

export async function demoScopedReport(scope: ReportScope, primaryTeam: string | undefined) {
  const totals = (closings: number) => ({
    closings, usd_minor: closings * 65000, showed: closings * 2, happened: closings * 4, show_rate: 0.5,
  });
  return readScopedReport(scope, primaryTeam, {
    demo: true,
    async payroll(range) {
      const days = 1 + (Date.parse(range.through) - Date.parse(range.from)) / 86_400_000;
      return {
        data: {
          summary: { ...totals(days * 3), absent_shows: null },
          teams: [
            { label: "Team Fahad", ...totals(days * 2) },
            { label: "Team Mike", ...totals(days) },
          ],
        },
        fetched_at: new Date().toISOString(),
      };
    },
    async scoring(range) {
      return {
        complete: true,
        rows: [72, 84, 78].map((score) => ({
          date: range.from, time: null, duration: null, consultant: "Demo consultant", prospect: "Demo prospect",
          practice: "Demo", score, band: null, outcome: null,
        })),
      };
    },
  });
}
