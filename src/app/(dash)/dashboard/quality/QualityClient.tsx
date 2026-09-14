"use client";

import * as React from "react";
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
import Link from "next/link";
import { ShieldCheck, ShieldOff, AlertTriangle, Timer, MessageSquare, FileText, HelpCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/utils";
import type { RagQuality } from "@/lib/rag-quality";
import type { KnowledgeInsights } from "@/lib/knowledge-insights";

const SOURCE_LABELS: Record<string, string> = {
  document: "Document",
  call_score: "Call score",
  coaching: "Coaching",
  transcript: "Transcript",
};

const RANGES = [7, 30, 90] as const;

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const ms = (v: number | null) => (v === null ? "—" : v < 1000 ? `${v}ms` : `${(v / 1000).toFixed(1)}s`);

export function QualityClient({ data, insights }: { data: RagQuality; insights: KnowledgeInsights }) {
  const router = useRouter();
  const params = useSearchParams();
  const days = Number(params.get("days")) || data.days;

  function setDays(d: number) {
    const q = new URLSearchParams(Array.from(params.entries()));
    q.set("days", String(d));
    router.push(`/dashboard/quality?${q.toString()}`);
  }

  const groundedTone = data.groundedRate === null ? "muted" : data.groundedRate >= 0.8 ? "ok" : data.groundedRate >= 0.5 ? "warn" : "bad";
  const fabTone = data.fabricationRate === null ? "muted" : data.fabricationRate === 0 ? "ok" : data.fabricationRate < 0.05 ? "warn" : "bad";

  return (
    <div className="space-y-6">
      {/* Range selector */}
      <div className="flex items-center justify-end gap-1">
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setDays(r)}
            className={cn(
              "rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors",
              days === r ? "border-accent bg-accent/10 text-accent" : "border-border text-muted-foreground hover:bg-surface-muted"
            )}
          >
            {r}d
          </button>
        ))}
      </div>

      {data.totalAnswers === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="No answers in this window"
          description="Once the chatbot answers questions, grounded rate, refusals, and citation health show up here."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric icon={ShieldCheck} tone={groundedTone} label="Grounded rate" value={pct(data.groundedRate)} hint={`${data.grounded}/${data.analyzed} verified answers`} />
            <Metric icon={ShieldOff} tone={data.ungrounded > 0 ? "warn" : "muted"} label="Ungrounded / refused" value={data.ungrounded.toLocaleString()} hint="answered without support or refused" />
            <Metric icon={AlertTriangle} tone={fabTone} label="Citation issues" value={pct(data.fabricationRate)} hint={`${data.fabricationEvents} answers · ${data.fabricatedCitations} bad ids`} />
            <Metric icon={Timer} tone="muted" label="Latency (p95)" value={ms(data.p95LatencyMs)} hint={`avg ${ms(data.avgLatencyMs)}`} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Grounded rate over time</CardTitle>
            </CardHeader>
            <CardContent>
              {data.series.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">Not enough data to chart yet.</p>
              ) : (
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={data.series} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
                      <defs>
                        <linearGradient id="gr" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#14b8a6" stopOpacity={0.4} />
                          <stop offset="100%" stopColor="#14b8a6" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--border))" vertical={false} />
                      <XAxis dataKey="date" tick={{ fill: "rgb(var(--muted-foreground))", fontSize: 11 }} tickFormatter={(d: string) => d.slice(5)} tickLine={false} axisLine={{ stroke: "rgb(var(--border))" }} />
                      <YAxis domain={[0, 1]} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} tick={{ fill: "rgb(var(--muted-foreground))", fontSize: 11 }} tickLine={false} axisLine={false} width={44} />
                      <Tooltip
                        contentStyle={{ background: "rgb(var(--surface))", border: "1px solid rgb(var(--border))", borderRadius: 10, fontSize: 12 }}
                        formatter={(v: number) => [`${Math.round((v ?? 0) * 100)}%`, "Grounded"]}
                      />
                      <Area type="monotone" dataKey="groundedRate" stroke="#14b8a6" strokeWidth={2} fill="url(#gr)" connectNulls />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Knowledge intelligence from the per-answer query log (migration 0014). */}
          {insights.enabled ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-accent" /> Most-used knowledge sources
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {insights.mostUsedSources.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">No source usage recorded yet.</p>
                  ) : (
                    <ul className="space-y-1">
                      {insights.mostUsedSources.map((s, i) => (
                        <li key={s.documentId} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-muted">
                          <span className="w-5 shrink-0 text-center text-xs font-semibold text-muted-foreground">{i + 1}</span>
                          <Link href={`/dashboard/documents/${s.documentId}`} className="min-w-0 flex-1 truncate text-sm font-medium text-accent hover:underline">
                            {s.title || "Untitled"}
                          </Link>
                          {s.sourceType && <Badge tone="neutral">{SOURCE_LABELS[s.sourceType] ?? s.sourceType}</Badge>}
                          <span className="w-16 shrink-0 text-right text-sm tabular-nums text-muted-foreground">{s.uses} uses</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <HelpCircle className="h-4 w-4 text-amber-500" /> Top unanswered questions
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {insights.topUnanswered.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                      No knowledge gaps — every question found support. 🎉
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {insights.topUnanswered.map((g, i) => (
                        <li key={i} className="flex items-start gap-3 rounded-lg px-2 py-1.5">
                          <span className="mt-0.5 shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-500">{g.count}×</span>
                          <span className="min-w-0 flex-1 text-sm">{g.query}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-3 text-xs text-muted-foreground">
                    Questions the chatbot refused or couldn&apos;t ground — the knowledge to add next.
                  </p>
                </CardContent>
              </Card>
            </div>
          ) : (
            <Card>
              <CardContent className="p-5">
                <p className="text-sm font-medium">Most-used sources &amp; knowledge gaps aren&apos;t enabled yet</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Run migration <code>0014_query_log.sql</code> to start logging which sources answers use and which
                  questions go unanswered.
                </p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="p-5">
              <h2 className="text-base font-semibold">What these mean</h2>
              <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
                <li><strong className="text-foreground">Grounded rate</strong> — answers the faithfulness check confirmed were supported by retrieved context. Higher is more trustworthy.</li>
                <li><strong className="text-foreground">Ungrounded / refused</strong> — the model either couldn&apos;t support its answer or correctly refused. A rising count can mean a knowledge gap.</li>
                <li><strong className="text-foreground">Citation issues</strong> — answers that cited an id that wasn&apos;t in the retrieved set (caught + counted, never shown as a real source).</li>
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Metric({
  icon: Icon,
  tone,
  label,
  value,
  hint,
}: {
  icon: typeof ShieldCheck;
  tone: "ok" | "warn" | "bad" | "muted";
  label: string;
  value: string;
  hint: string;
}) {
  const iconCls =
    tone === "ok" ? "bg-emerald-500/15 text-emerald-500" : tone === "bad" ? "bg-rose-500/15 text-rose-500" : tone === "warn" ? "bg-amber-500/15 text-amber-500" : "bg-surface-muted text-muted-foreground";
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm text-muted-foreground">{label}</p>
          <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", iconCls)}>
            <Icon className="h-4 w-4" aria-hidden />
          </span>
        </div>
        <p className="mt-2 text-3xl font-semibold tabular-nums">{value}</p>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}
