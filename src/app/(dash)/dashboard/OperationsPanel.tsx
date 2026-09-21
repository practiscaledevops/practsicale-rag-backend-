"use client";

// "Operations & data health" — the operational layer under the AI Brain
// overview: documents and chunks, ingestion health, knowledge by source and
// collection, what needs attention, quick actions and this month's model cost.
// Presentational only — every number is computed org-scoped on the server
// (lib/dashboard-metrics); this just arranges it.

import Link from "next/link";
import {
  FileText,
  Layers,
  AlertTriangle,
  Activity,
  Lock,
  Upload,
  Cpu,
  FlaskConical,
  Database,
  PlusCircle,
  ArrowRight,
  CheckCircle2,
  DollarSign,
  type LucideIcon,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { C, Panel } from "@/components/ui/brain-ui";
import { cn } from "@/lib/utils";
import type { ControlTowerData } from "@/lib/dashboard-metrics";

const num = (v: number | null) => (v === null ? "—" : v.toLocaleString());
const money = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function relTime(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "never";
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const KIND_BADGE: Record<string, { label: string; cls: string }> = {
  pull_http: { label: "API sync", cls: "bg-accent/15 text-accent" },
  upload: { label: "Manual", cls: "bg-accent/10 text-foreground" },
  push_webhook: { label: "Webhook", cls: "bg-purple-500/15 text-purple-300" },
};

// Inner cards sit on the panel surface, so they take the raised tone (like the Brain sections' tiles).
const raised = { background: C.raised };

export function OperationsPanel({ data, email }: { data: ControlTowerData; email: string }) {
  const embeddedPct =
    data.totalChunks && data.totalChunks > 0 && data.embeddedChunks !== null
      ? Math.round((data.embeddedChunks / data.totalChunks) * 100)
      : null;

  const runTotal = data.runStats.success + data.runStats.error + data.runStats.running;
  const successPct = runTotal > 0 ? Math.round((data.runStats.success / runTotal) * 100) : 100;
  const healthy = data.runStats.error === 0 && data.needsReview === 0 && (embeddedPct === null || embeddedPct === 100);

  return (
    <Panel
      title="Operations & data health"
      subtitle="The machinery that feeds the Brain: documents and chunks, ingestion runs, sources and this month's model cost."
    >
      <div className="space-y-4">
        {/* Small stats */}
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Stat icon={FileText} label="Documents" value={num(data.documents)} hint="raw and compiled, every source" tone="accent" />
          <Stat
            icon={Layers}
            label="Chunks embedded"
            value={num(data.embeddedChunks)}
            hint={embeddedPct === null ? `${num(data.totalChunks)} chunks total` : `${embeddedPct}% of ${num(data.totalChunks)} searchable`}
            tone={embeddedPct !== null && embeddedPct < 100 ? "warning" : "accent"}
          />
          <Stat
            icon={Cpu}
            label="Runs succeeded"
            value={String(data.runStats.success)}
            hint={`${data.runStats.error} failed · ${data.runStats.running} running`}
            tone={data.runStats.error > 0 ? "warning" : "accent"}
          />
          <Stat
            icon={AlertTriangle}
            label="Sources to review"
            value={String(data.needsReview)}
            hint="errored or not synced in 7 days"
            tone={data.needsReview > 0 ? "warning" : "muted"}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Knowledge by source */}
          <Card className="lg:col-span-2" style={raised}>
            <CardContent className="p-5">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-base font-semibold">Knowledge by source and collection</h3>
                <Link href="/dashboard/sources" className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground">
                  View all sources
                </Link>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <TypeChip label="Documents" value={data.bySourceType.document} />
                <TypeChip label="Call scores" value={data.bySourceType.call_score} />
                <TypeChip label="Transcripts" value={data.bySourceType.transcript} />
                <TypeChip label="Coaching" value={data.bySourceType.coaching} />
              </div>

              <ul className="mt-4 divide-y divide-border">
                {data.dataSources.length === 0 ? (
                  <li className="py-6 text-center text-sm text-muted-foreground">
                    No knowledge sources yet.{" "}
                    <Link href="/dashboard/uploads" className="text-accent hover:underline">Upload or connect one.</Link>
                  </li>
                ) : (
                  data.dataSources.slice(0, 6).map((s) => {
                    const badge = KIND_BADGE[s.kind] ?? KIND_BADGE.upload;
                    return (
                      <li key={s.id} className="flex items-center gap-3 py-3">
                        <Link href={`/dashboard/sources/${s.id}`} className="min-w-0 flex-1 rounded-md transition-colors hover:opacity-80">
                          <span className="flex items-center gap-1.5 text-sm font-medium">
                            {s.name}
                            {s.sourceType === "call_score" && <Lock size={12} className="text-muted-foreground" aria-hidden />}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {s.sourceType.replace(/_/g, " ")} · synced {relTime(s.lastRunAt)}
                          </span>
                        </Link>
                        <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", badge.cls)}>
                          {badge.label}
                        </span>
                        <span className={cn("text-xs font-medium", s.needsAttention ? "text-amber-500" : "text-emerald-500")}>
                          {s.needsAttention ? "Attention" : "Healthy"}
                        </span>
                      </li>
                    );
                  })
                )}
              </ul>
            </CardContent>
          </Card>

          {/* Right column: health + attention + quick actions */}
          <div className="space-y-4">
            <Card style={raised}>
              <CardContent className="p-5">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="flex items-center gap-2 text-base font-semibold">
                    <Activity size={16} className="text-accent" /> Ingestion health
                  </h3>
                  <span className="text-xs text-muted-foreground">Live</span>
                </div>
                <HealthBar label="Success rate" pct={successPct} tone={successPct >= 80 ? "ok" : successPct >= 50 ? "warn" : "bad"} caption={`${data.runStats.success}/${runTotal || 0} runs`} />
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <MiniStat label="Succeeded" value={data.runStats.success} tone="ok" />
                  <MiniStat label="Failed" value={data.runStats.error} tone={data.runStats.error > 0 ? "bad" : "muted"} />
                  <MiniStat label="Running" value={data.runStats.running} tone="muted" />
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Last successful sync {relTime(data.runStats.lastSuccessAt)} · {money(data.usage.costUsd)} model cost this month
                </p>
              </CardContent>
            </Card>

            <Card style={raised}>
              <CardContent className="p-5">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-base font-semibold">Needs attention</h3>
                  <span className="text-xs text-muted-foreground">Actionable</span>
                </div>
                <div className="space-y-3">
                  {data.runStats.error > 0 && (
                    <Attention icon={AlertTriangle} tone="bad" title="Verify failed or delayed runs" body={`${data.runStats.error} run${data.runStats.error === 1 ? "" : "s"} errored recently. Open the run log and retry safely.`} href="/dashboard/processing" />
                  )}
                  {data.needsReview > 0 && (
                    <Attention icon={AlertTriangle} tone="warn" title="Review stale sources" body={`${data.needsReview} source${data.needsReview === 1 ? "" : "s"} errored or have not synced in 7 days.`} href="/dashboard/quality-data" />
                  )}
                  {embeddedPct !== null && embeddedPct < 100 && (
                    <Attention icon={Layers} tone="warn" title="Some knowledge isn't searchable yet" body={`${embeddedPct}% of chunks are embedded. Check data quality for stragglers.`} href="/dashboard/quality-data" />
                  )}
                  {data.usage.costUsd > 0 && (
                    <Attention icon={DollarSign} tone="info" title="Model cost this month" body={`${money(data.usage.costUsd)} — ${money(data.usage.byProvider.anthropic)} Anthropic, ${money(data.usage.byProvider.openai)} OpenAI.`} href="/dashboard/analytics" />
                  )}
                  {healthy && (
                    <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5 text-sm">
                      <CheckCircle2 size={16} className="text-emerald-500" />
                      Ingestion is healthy. Nothing needs your attention.
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card style={raised}>
              <CardContent className="p-5">
                <h3 className="mb-3 text-base font-semibold">Quick actions</h3>
                <div className="space-y-2">
                  <ActionLink icon={PlusCircle} label="Add knowledge to the Brain" href="/dashboard/knowledge/add" />
                  <ActionLink icon={Upload} label="Bulk upload documents" href="/dashboard/uploads" />
                  <ActionLink icon={Cpu} label="Open processing runs" href="/dashboard/processing" />
                  <ActionLink icon={Database} label="Manage knowledge sources" href="/dashboard/sources" />
                  <ActionLink icon={FlaskConical} label="Test answers in RAG playground" href="/dashboard/playground" />
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">Signed in as {email}</p>
      </div>
    </Panel>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint: string;
  tone: "accent" | "warning" | "muted";
}) {
  return (
    <Card style={raised}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs text-muted-foreground">{label}</p>
          <span
            className={cn(
              "grid h-7 w-7 shrink-0 place-items-center rounded-lg",
              tone === "warning" ? "bg-amber-500/15 text-amber-500" : tone === "muted" ? "bg-surface-muted text-muted-foreground" : "bg-accent/15 text-accent"
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </span>
        </div>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className={cn("h-1.5 w-1.5 rounded-full", tone === "warning" ? "bg-amber-500" : "bg-accent")} />
          {hint}
        </p>
      </CardContent>
    </Card>
  );
}

function TypeChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-surface-muted/40 px-3 py-2">
      <p className="text-lg font-semibold tabular-nums">{value.toLocaleString()}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}

function HealthBar({ label, pct, tone, caption }: { label: string; pct: number; tone: "ok" | "warn" | "bad"; caption: string }) {
  const bar = tone === "ok" ? "bg-emerald-500" : tone === "warn" ? "bg-amber-500" : "bg-rose-500";
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums text-muted-foreground">{caption}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-surface-muted">
        <div className={cn("h-full rounded-full", bar)} style={{ width: `${Math.max(4, pct)}%` }} />
      </div>
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: number; tone: "ok" | "bad" | "muted" }) {
  const cls = tone === "ok" ? "text-emerald-500" : tone === "bad" ? "text-rose-500" : "text-muted-foreground";
  return (
    <div className="rounded-lg bg-surface-muted/40 py-2">
      <p className={cn("text-lg font-semibold tabular-nums", cls)}>{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}

function Attention({ icon: Icon, tone, title, body, href }: { icon: LucideIcon; tone: "bad" | "warn" | "info"; title: string; body: string; href: string }) {
  const iconCls = tone === "bad" ? "text-rose-500" : tone === "warn" ? "text-amber-500" : "text-sky-500";
  return (
    <Link href={href} className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-surface-muted">
      <Icon size={16} className={cn("mt-0.5 shrink-0", iconCls)} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{body}</span>
      </span>
      <ArrowRight size={14} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
    </Link>
  );
}

function ActionLink({ icon: Icon, label, href }: { icon: LucideIcon; label: string; href: string }) {
  return (
    <Link href={href} className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2.5 text-sm transition-colors hover:bg-surface-muted">
      <Icon size={16} className="shrink-0 text-accent" aria-hidden />
      <span className="flex-1">{label}</span>
      <ArrowRight size={14} className="shrink-0 text-muted-foreground" aria-hidden />
    </Link>
  );
}
