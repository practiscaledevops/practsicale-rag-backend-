"use client";

// The Team view of the Overview: the machinery that feeds the Brain —
// documents and chunks, ingestion health, knowledge by source and collection,
// what needs attention, quick actions and this month's model cost.
// Presentational only — every number is computed org-scoped on the server
// (lib/dashboard-metrics); this just arranges it. One card level: stat tiles
// on top, then section cards whose bodies are rows or grids.

import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Cpu,
  Database,
  DollarSign,
  FileText,
  FlaskConical,
  Layers,
  ListChecks,
  Lock,
  PlusCircle,
  Upload,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  Badge,
  CompactStat,
  Meter,
  RelTime,
  SectionCard,
  StatGrid,
  StatTile,
  StatusDot,
  buttonClass,
  type MeterTone,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { fmtMoney, fmtNumber } from "@/lib/format";
import { sourceTypeLabel } from "@/lib/ui-labels";
import type { ControlTowerData } from "@/lib/dashboard-metrics";

/** Connection kind labels (categorical, so every kind is a neutral badge). */
const KIND_LABEL: Record<string, string> = {
  pull_http: "API sync",
  upload: "Manual",
  push_webhook: "Webhook",
};

// `email` is still accepted (the page passes it) but no longer shown: the rail's
// profile card already says who is signed in.
export function OperationsPanel({ data }: { data: ControlTowerData; email: string }) {
  const embeddedPct =
    data.totalChunks && data.totalChunks > 0 && data.embeddedChunks !== null
      ? Math.round((data.embeddedChunks / data.totalChunks) * 100)
      : null;

  const runTotal = data.runStats.success + data.runStats.error + data.runStats.running;
  // No runs yet is "no data", not a 100% success rate.
  const successPct = runTotal > 0 ? Math.round((data.runStats.success / runTotal) * 100) : null;
  const successTone: MeterTone =
    successPct === null ? "accent" : successPct >= 80 ? "success" : successPct >= 50 ? "warning" : "danger";
  const healthy = data.runStats.error === 0 && data.needsReview === 0 && (embeddedPct === null || embeddedPct === 100);

  return (
    <div className="space-y-4">
      <section aria-label="Operations at a glance">
        <StatGrid cols={4}>
          <StatTile icon={FileText} label="Documents" value={fmtNumber(data.documents)} hint="Raw and compiled, every source" />
          <StatTile
            icon={Layers}
            label="Chunks embedded"
            value={fmtNumber(data.embeddedChunks)}
            hint={
              embeddedPct === null
                ? `${fmtNumber(data.totalChunks)} chunks total`
                : `${embeddedPct}% of ${fmtNumber(data.totalChunks)} searchable`
            }
            tone={embeddedPct !== null && embeddedPct < 100 ? "warning" : "default"}
          />
          <StatTile
            icon={Cpu}
            label="Runs succeeded"
            value={fmtNumber(data.runStats.success)}
            hint={`${fmtNumber(data.runStats.error)} failed · ${fmtNumber(data.runStats.running)} running`}
            tone={data.runStats.error > 0 ? "warning" : "default"}
          />
          <StatTile
            icon={AlertTriangle}
            label="Sources to review"
            value={fmtNumber(data.needsReview)}
            hint="Errored or not synced in 7 days"
            tone={data.needsReview > 0 ? "warning" : "default"}
          />
        </StatGrid>
      </section>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        {/* Knowledge by source */}
        <SectionCard
          icon={Database}
          title="Knowledge by source and collection"
          className="lg:col-span-2"
          bodyClassName="p-0"
          actions={
            <Link href="/dashboard/sources" className={buttonClass({ variant: "secondary", size: "sm" })}>
              View all sources
            </Link>
          }
        >
          <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-4">
            <CompactStat label="Documents" value={fmtNumber(data.bySourceType.document)} />
            <CompactStat label="Call scores" value={fmtNumber(data.bySourceType.call_score)} />
            <CompactStat label="Transcripts" value={fmtNumber(data.bySourceType.transcript)} />
            <CompactStat label="Coaching" value={fmtNumber(data.bySourceType.coaching)} />
          </div>

          <ul className="divide-y divide-border border-t border-border">
            {data.dataSources.length === 0 ? (
              <li className="px-4 py-6 text-center text-[13px] text-muted-foreground">
                No knowledge sources yet.{" "}
                <Link href="/dashboard/uploads" className="font-medium text-accent-strong hover:underline">
                  Upload or connect one.
                </Link>
              </li>
            ) : (
              data.dataSources.slice(0, 6).map((s) => {
                // Paused and never-synced sources are neutral, not green (an active
                // source with no runs already needs attention via isStale).
                const status: { tone: "warning" | "neutral" | "success"; label: string } = s.needsAttention
                  ? { tone: "warning", label: "Attention" }
                  : !s.isActive
                    ? { tone: "neutral", label: "Paused" }
                    : !s.lastRunAt
                      ? { tone: "neutral", label: "Never synced" }
                      : { tone: "success", label: "Healthy" };
                return (
                  <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                    <Link
                      href={`/dashboard/sources/${s.id}`}
                      className="group/source min-w-0 flex-1 rounded-md"
                    >
                      <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground group-hover/source:text-accent-strong group-hover/source:underline">
                        <span className="truncate">{s.name}</span>
                        {s.sourceType === "call_score" && (
                          <>
                            <Lock size={12} aria-hidden className="shrink-0 text-private" />
                            <span className="sr-only">(confidential)</span>
                          </>
                        )}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {sourceTypeLabel(s.sourceType)} ·{" "}
                        {s.lastRunAt ? (
                          <>
                            synced <RelTime iso={s.lastRunAt} />
                          </>
                        ) : (
                          "never synced"
                        )}
                      </span>
                    </Link>
                    <Badge tone="neutral" className="hidden sm:inline-flex">
                      {KIND_LABEL[s.kind] ?? KIND_LABEL.upload}
                    </Badge>
                    <StatusDot tone={status.tone} className="shrink-0">
                      {status.label}
                    </StatusDot>
                  </li>
                );
              })
            )}
          </ul>
        </SectionCard>

        {/* Right column: health + attention + quick actions */}
        <div className="space-y-4">
          <SectionCard icon={Activity} title="Ingestion health" description="Over the 50 most recent runs.">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[13px] text-muted-foreground">Success rate</span>
              <span className="text-[22px] font-semibold leading-7 tracking-tight tabular-nums text-foreground">
                {successPct === null ? "—" : `${successPct}%`}
              </span>
            </div>
            <Meter
              className="mt-2"
              value={successPct ?? 0}
              max={100}
              label="Ingestion success rate"
              tone={successTone}
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              {successPct === null
                ? "No runs yet"
                : `${fmtNumber(data.runStats.success)} of ${fmtNumber(runTotal)} runs succeeded`}
            </p>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <CompactStat label="Succeeded" value={fmtNumber(data.runStats.success)} />
              <CompactStat
                label="Failed"
                value={
                  data.runStats.error > 0 ? (
                    <span className="text-danger">{fmtNumber(data.runStats.error)}</span>
                  ) : (
                    fmtNumber(data.runStats.error)
                  )
                }
              />
              <CompactStat label="Running" value={fmtNumber(data.runStats.running)} />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Last successful sync <RelTime iso={data.runStats.lastSuccessAt} /> · {fmtMoney(data.usage.costUsd)} model cost
              this month
            </p>
          </SectionCard>

          <SectionCard icon={ListChecks} title="Needs attention" bodyClassName="p-0">
            <ul className="divide-y divide-border">
              {data.runStats.error > 0 && (
                <Attention
                  icon={AlertTriangle}
                  tone="danger"
                  title="Verify failed or delayed runs"
                  body={`${data.runStats.error} run${data.runStats.error === 1 ? "" : "s"} errored recently. Open the run log and retry safely.`}
                  href="/dashboard/processing"
                />
              )}
              {data.needsReview > 0 && (
                <Attention
                  icon={AlertTriangle}
                  tone="warning"
                  title="Review stale sources"
                  body={`${data.needsReview} source${data.needsReview === 1 ? "" : "s"} errored or have not synced in 7 days.`}
                  href="/dashboard/quality-data"
                />
              )}
              {embeddedPct !== null && embeddedPct < 100 && (
                <Attention
                  icon={Layers}
                  tone="warning"
                  title="Some knowledge isn't searchable yet"
                  body={`${embeddedPct}% of chunks are embedded. Check data quality for stragglers.`}
                  href="/dashboard/quality-data"
                />
              )}
              {data.usage.costUsd > 0 && (
                <Attention
                  icon={DollarSign}
                  tone="info"
                  title="Model cost this month"
                  body={`${fmtMoney(data.usage.costUsd)}: ${fmtMoney(data.usage.byProvider.anthropic)} Anthropic, ${fmtMoney(data.usage.byProvider.openai)} OpenAI.`}
                  href="/dashboard/analytics"
                />
              )}
              {healthy && (
                <li className="flex items-center gap-2.5 px-4 py-2.5 text-[13px] text-foreground">
                  <CheckCircle2 size={16} aria-hidden className="shrink-0 text-success" />
                  Ingestion is healthy. Nothing needs your attention.
                </li>
              )}
            </ul>
          </SectionCard>

          <SectionCard icon={Zap} title="Quick actions">
            <div className="flex flex-wrap gap-2">
              <QuickAction icon={PlusCircle} label="Add knowledge" href="/dashboard/knowledge/add" />
              <QuickAction icon={Upload} label="Bulk upload" href="/dashboard/uploads" />
              <QuickAction icon={Cpu} label="Processing runs" href="/dashboard/processing" />
              <QuickAction icon={Database} label="Sources" href="/dashboard/sources" />
              <QuickAction icon={FlaskConical} label="Playground" href="/dashboard/playground" />
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

const ATTENTION_ICON: Record<"danger" | "warning" | "info", string> = {
  danger: "text-danger",
  warning: "text-warning",
  info: "text-info",
};

function Attention({
  icon: Icon,
  tone,
  title,
  body,
  href,
}: {
  icon: LucideIcon;
  tone: "danger" | "warning" | "info";
  title: string;
  body: string;
  href: string;
}) {
  return (
    <li>
      <Link
        href={href}
        className="flex items-start gap-2.5 px-4 py-2.5 transition-colors hover:bg-surface-muted/60"
      >
        <Icon size={16} aria-hidden className={cn("mt-0.5 shrink-0", ATTENTION_ICON[tone])} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-foreground">{title}</span>
          <span className="block text-xs text-muted-foreground">{body}</span>
        </span>
        <ArrowRight size={14} aria-hidden className="mt-0.5 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}

function QuickAction({ icon: Icon, label, href }: { icon: LucideIcon; label: string; href: string }) {
  return (
    <Link href={href} className={buttonClass({ variant: "secondary", size: "toolbar" })}>
      <Icon size={14} aria-hidden className="shrink-0 text-accent" />
      {label}
    </Link>
  );
}
