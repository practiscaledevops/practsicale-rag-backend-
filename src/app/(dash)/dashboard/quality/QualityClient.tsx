"use client";

// Query intelligence: answer-quality signals (grounded rate, refusals, citation
// issues, latency) plus the most-used sources and the questions the Brain
// couldn't answer. Every number arrives from the server for the ?days window;
// changing the range navigates to the new window (the server re-reads it).

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import {
  AlertTriangle,
  FileText,
  HelpCircle,
  Info,
  Loader2,
  MessageSquare,
  Plus,
  ShieldCheck,
  ShieldOff,
  Timer,
  TrendingUp,
} from "lucide-react";
import {
  Alert,
  Badge,
  EmptyState,
  PageHeader,
  SectionCard,
  Segmented,
  StatGrid,
  StatTile,
  buttonClass,
  type SegmentedOption,
  type StatTone,
} from "@/components/ui";
import { CHART } from "@/lib/chart-theme";
import { fmtDuration, fmtNumber, fmtPct } from "@/lib/format";
import { sourceTypeLabel } from "@/lib/ui-labels";
import type { RagQuality } from "@/lib/rag-quality";
import type { KnowledgeInsights } from "@/lib/knowledge-insights";

const RANGES = [7, 30, 90] as const;
const RANGE_OPTIONS: SegmentedOption<string>[] = RANGES.map((r) => ({ value: String(r), label: `${r} days` }));

/** Signal strength -> StatTile icon tone (the value itself stays foreground). */
type Signal = "ok" | "warn" | "bad" | "muted";
const SIGNAL_TONE: Record<Signal, StatTone> = { ok: "success", warn: "warning", bad: "danger", muted: "neutral" };

const dayShort = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const dayLong = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
/** Series days are UTC "YYYY-MM-DD" buckets. */
const fmtDay = (d: string) => dayShort.format(new Date(`${d}T00:00:00Z`));
const fmtDayLong = (d: string) => dayLong.format(new Date(`${d}T00:00:00Z`));

export function QualityClient({ data, insights }: { data: RagQuality; insights: KnowledgeInsights }) {
  const router = useRouter();
  const params = useSearchParams();
  const days = Number(params.get("days")) || data.days;

  // The range is a server navigation; the transition only drives the
  // "Updating…" cue and shows the chosen range while the server responds.
  const [pending, startTransition] = React.useTransition();
  const [target, setTarget] = React.useState<number | null>(null);
  const shownDays = pending && target !== null ? target : days;

  function setDays(d: number) {
    const q = new URLSearchParams(Array.from(params.entries()));
    q.set("days", String(d));
    setTarget(d);
    startTransition(() => {
      router.push(`/dashboard/quality?${q.toString()}`);
    });
  }

  const groundedTone: Signal = data.groundedRate === null ? "muted" : data.groundedRate >= 0.8 ? "ok" : data.groundedRate >= 0.5 ? "warn" : "bad";
  const fabTone: Signal = data.fabricationRate === null ? "muted" : data.fabricationRate === 0 ? "ok" : data.fabricationRate < 0.05 ? "warn" : "bad";

  return (
    <div>
      <PageHeader
        title="Query intelligence"
        description="Answer quality from real chatbot usage: how often answers are grounded, refused, or cite something that wasn't retrieved, plus the most-used sources and the questions we can't answer yet."
        actions={
          <>
            {pending && (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 size={14} aria-hidden className="animate-spin" />
                Updating…
              </span>
            )}
            <Segmented
              label="Date range"
              value={String(shownDays)}
              options={RANGE_OPTIONS}
              onChange={(v) => setDays(Number(v))}
            />
          </>
        }
      />

      <div className="space-y-4" aria-busy={pending || undefined}>
        {data.totalAnswers === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="No answers in this window"
            description="Once the chatbot answers questions, grounded rate, refusals, and citation health show up here."
          />
        ) : (
          <>
            <section aria-label="Answer quality">
              <StatGrid cols={4}>
                <StatTile
                  icon={ShieldCheck}
                  tone={SIGNAL_TONE[groundedTone]}
                  label="Grounded rate"
                  value={fmtPct(data.groundedRate)}
                  hint={`${fmtNumber(data.grounded)} of ${fmtNumber(data.analyzed)} verified answers`}
                />
                <StatTile
                  icon={ShieldOff}
                  tone={data.ungrounded > 0 ? "warning" : "default"}
                  label="Ungrounded or refused"
                  value={fmtNumber(data.ungrounded)}
                  hint="Answered without support or refused"
                />
                <StatTile
                  icon={AlertTriangle}
                  tone={SIGNAL_TONE[fabTone]}
                  label="Citation issues"
                  value={fmtPct(data.fabricationRate)}
                  hint={`${fmtNumber(data.fabricationEvents)} answers · ${fmtNumber(data.fabricatedCitations)} bad ids`}
                />
                <StatTile
                  icon={Timer}
                  label="Latency (p95)"
                  value={fmtDuration(data.p95LatencyMs)}
                  hint={`Average ${fmtDuration(data.avgLatencyMs)}`}
                />
              </StatGrid>
            </section>

            <SectionCard
              icon={TrendingUp}
              title="Grounded rate over time"
              description={`Daily · last ${data.days} days`}
            >
              {data.series.length === 0 ? (
                <p className="py-8 text-center text-[13px] text-muted-foreground">Not enough data to chart yet.</p>
              ) : (
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={data.series} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
                      <defs>
                        <linearGradient id="quality-grounded-fill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={CHART.primary} stopOpacity={0.35} />
                          <stop offset="100%" stopColor={CHART.primary} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} vertical={false} />
                      <XAxis
                        dataKey="date"
                        tick={CHART.tick}
                        tickFormatter={fmtDay}
                        tickLine={false}
                        axisLine={false}
                        minTickGap={24}
                      />
                      <YAxis
                        domain={[0, 1]}
                        tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
                        tick={CHART.tick}
                        tickLine={false}
                        axisLine={false}
                        width={44}
                      />
                      <Tooltip
                        contentStyle={CHART.tooltip.contentStyle}
                        labelStyle={CHART.tooltip.labelStyle}
                        itemStyle={CHART.tooltip.itemStyle}
                        cursor={{ stroke: CHART.axis, strokeOpacity: 0.35 }}
                        labelFormatter={(l) => fmtDayLong(String(l))}
                        formatter={(v: number) => [`${Math.round((v ?? 0) * 100)}%`, "Grounded"]}
                      />
                      <Area
                        type="monotone"
                        dataKey="groundedRate"
                        stroke={CHART.primary}
                        strokeWidth={2}
                        fill="url(#quality-grounded-fill)"
                        activeDot={{ r: 4, fill: CHART.primary, stroke: "rgb(var(--surface))", strokeWidth: 2 }}
                        connectNulls
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </SectionCard>

            {/* Knowledge intelligence from the per-answer query log (migration 0014). */}
            {insights.enabled ? (
              <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
                <SectionCard icon={FileText} title="Most-used knowledge sources" bodyClassName="p-0">
                  {insights.mostUsedSources.length === 0 ? (
                    <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">No source usage recorded yet.</p>
                  ) : (
                    <ol className="divide-y divide-border">
                      {insights.mostUsedSources.map((s, i) => (
                        <li key={s.documentId} className="flex items-center gap-3 px-4 py-2">
                          <span className="w-5 shrink-0 text-center text-xs font-medium tabular-nums text-muted-foreground">
                            {i + 1}
                          </span>
                          <Link
                            href={`/dashboard/documents/${s.documentId}`}
                            className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground hover:text-accent-strong hover:underline"
                          >
                            {s.title || "Untitled"}
                          </Link>
                          {s.sourceType && (
                            <Badge tone="neutral" className="hidden sm:inline-flex">
                              {sourceTypeLabel(s.sourceType)}
                            </Badge>
                          )}
                          <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                            {fmtNumber(s.uses)} uses
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </SectionCard>

                <SectionCard
                  icon={HelpCircle}
                  title="Top unanswered questions"
                  description="Questions the chatbot refused or couldn't ground: the knowledge to add next."
                  bodyClassName="p-0"
                >
                  {insights.topUnanswered.length === 0 ? (
                    <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">
                      No knowledge gaps. Every question found support.
                    </p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {insights.topUnanswered.map((g, i) => (
                        <li key={i} className="flex items-start gap-3 px-4 py-2">
                          <Badge tone="warning" className="mt-1 shrink-0 tabular-nums" title={`Asked ${g.count} times`}>
                            {g.count}×
                          </Badge>
                          <span className="min-w-0 flex-1 break-words py-0.5 text-[13px] text-foreground">{g.query}</span>
                          <Link
                            href="/dashboard/knowledge/add"
                            className={buttonClass({ variant: "ghost", size: "sm", className: "shrink-0" })}
                          >
                            <Plus size={14} aria-hidden />
                            <span className="sr-only sm:not-sr-only">Add knowledge</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </SectionCard>
              </div>
            ) : (
              <Alert tone="info" title="Not enabled yet" role="note">
                <p>
                  Most-used sources and knowledge gaps aren&apos;t switched on in this environment. Ask engineering to
                  enable them.
                </p>
                <details className="mt-1.5">
                  <summary className="cursor-pointer text-xs">Technical details</summary>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Run migration <code className="font-mono">0014_query_log.sql</code> to start logging which sources
                    answers use and which questions go unanswered.
                  </p>
                </details>
              </Alert>
            )}

            <SectionCard icon={Info} title="What these mean">
              <ul className="space-y-1.5 text-[13px] text-muted-foreground">
                <li>
                  <strong className="font-medium text-foreground">Grounded rate</strong>: answers the faithfulness check
                  confirmed were supported by retrieved context. Higher is more trustworthy.
                </li>
                <li>
                  <strong className="font-medium text-foreground">Ungrounded or refused</strong>: the model either
                  couldn&apos;t support its answer or correctly refused. A rising count can mean a knowledge gap.
                </li>
                <li>
                  <strong className="font-medium text-foreground">Citation issues</strong>: answers that cited an id that
                  wasn&apos;t in the retrieved set (caught and counted, never shown as a real source).
                </li>
              </ul>
            </SectionCard>
          </>
        )}
      </div>
    </div>
  );
}
