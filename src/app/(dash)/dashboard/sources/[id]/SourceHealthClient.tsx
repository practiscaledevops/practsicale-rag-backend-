"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CalendarCheck,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Clock,
  Gauge,
  GitCommitHorizontal,
  Loader2,
  Pause,
  Play,
  Plug,
  Radio,
  RefreshCw,
  ScrollText,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Menu,
  PageHeader,
  SectionCard,
  StatGrid,
  StatTile,
  Table,
  TableCard,
  TableEmptyRow,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  useConfirm,
  type BadgeTone,
  type MenuItem,
  type StatTone,
} from "@/components/ui";
import { fmtDateTime, fmtDuration, fmtInt, humanize, relTime } from "@/lib/format";
import { sourceTypeLabel, statusTone, triggerLabel } from "@/lib/ui-labels";
import { ingestionErrorSummary } from "@/lib/ingestion-error";

export interface SourceRun {
  status: string;
  trigger: string;
  ingested: number;
  chunks: number;
  skipped: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface SourceHealth {
  id: string;
  name: string;
  sourceType: string;
  kind: string;
  endpointUrl: string | null;
  httpMethod: string;
  authType: string;
  recordsPath: string | null;
  recordIdField: string | null;
  cursorField: string | null;
  cursorParam: string | null;
  cursorValue: string | null;
  scheduleCron: string | null;
  isActive: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastSuccessAt: string | null;
  totalIngested: number;
  totalChunks: number;
  totalSkipped: number;
  avgSyncDurationMs: number | null;
}

const AUTH_LABELS: Record<string, string> = {
  none: "No auth",
  bearer: "Bearer token auth",
  api_key: "API key auth",
  basic: "Basic auth",
};


const RUN_STATUS_LABELS: Record<string, string> = {
  success: "Succeeded",
  error: "Failed",
  running: "Running",
};

// true only after hydration, so locale-dependent strings never mismatch the server HTML.
const noopSubscribe = () => () => {};
function useHydrated() {
  return React.useSyncExternalStore(noopSubscribe, () => true, () => false);
}

/** Relative time ("5m ago") with the exact local date and time in its tooltip. */
function TimeAgo({ iso, never = "Never" }: { iso: string | null; never?: string }) {
  const hydrated = useHydrated();
  if (!iso) return <>{never}</>;
  return (
    <time dateTime={iso} title={hydrated ? fmtDateTime(iso) : undefined} suppressHydrationWarning>
      {relTime(iso, { never, absolute: hydrated })}
    </time>
  );
}

/** One label/value pair in a definition grid. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </>
  );
}

const Muted = ({ children }: { children: React.ReactNode }) => (
  <span className="text-muted-foreground">{children}</span>
);

export function SourceHealthClient({ health, runs }: { health: SourceHealth; runs: SourceRun[] }) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [syncing, setSyncing] = React.useState(false);
  const [toggling, setToggling] = React.useState(false);
  const [backfilling, setBackfilling] = React.useState(false);
  const [repairing, setRepairing] = React.useState(false);
  const [msg, setMsg] = React.useState<{ tone: "success" | "warning" | "danger"; text: string } | null>(null);
  React.useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible" && !syncing && !toggling && !backfilling && !repairing) router.refresh(); };
    const timer = setInterval(refresh, 15000);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [router, syncing, toggling, backfilling, repairing]);

  async function syncNow() {
    setSyncing(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/sources/${health.id}/sync`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ tone: "danger", text: json.error ?? `Sync failed (${res.status})` });
        return;
      }
      const found = json.documents_ingested ?? json.documentsIngested ?? 0;
      setMsg(/^partial:/i.test(json.error ?? "")
        ? { tone: "warning", text: `Batch saved — ${found} new records. The next sync resumes from the saved checkpoint.` }
        : { tone: "success", text: `Sync complete — ${found} new record${found === 1 ? "" : "s"} ingested.` });
      router.refresh();
    } catch {
      setMsg({ tone: "danger", text: "Network error — please try again." });
    } finally {
      setSyncing(false);
    }
  }

  async function backfillTranscripts() {
    setBackfilling(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/sources/${health.id}/backfill-transcripts`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ tone: "danger", text: json.error ?? `Back-fill failed (${res.status})` });
        return;
      }
      const created = json.transcriptsCreated ?? 0;
      const skipped = json.transcriptsSkipped ?? 0;
      const calls = json.calls ?? 0;
      setMsg({
        tone: "success",
        text: `Back-fill complete — ${created} transcript${created === 1 ? "" : "s"} added, ${skipped} already present (${calls} call${calls === 1 ? "" : "s"} scanned).`,
      });
      router.refresh();
    } catch {
      setMsg({ tone: "danger", text: "Network error — please try again." });
    } finally {
      setBackfilling(false);
    }
  }

  async function repairDates() {
    setRepairing(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/repair-call-dates`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ tone: "danger", text: json.error ?? `Repair failed (${res.status})` });
        return;
      }
      const c = json.chunks?.fixed ?? 0;
      const d = json.documents?.fixed ?? 0;
      setMsg({
        tone: "success",
        text: `Call dates aligned with the scoring app — ${c} chunk${c === 1 ? "" : "s"} and ${d} document${d === 1 ? "" : "s"} corrected.`,
      });
      router.refresh();
    } catch {
      setMsg({ tone: "danger", text: "Network error — please try again." });
    } finally {
      setRepairing(false);
    }
  }

  async function toggleActive() {
    setToggling(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/sources/${health.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ is_active: !health.isActive }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ tone: "danger", text: json.error ?? `Update failed (${res.status})` });
        return;
      }
      router.refresh();
    } catch {
      setMsg({ tone: "danger", text: "Network error — please try again." });
    } finally {
      setToggling(false);
    }
  }

  const errorState = health.lastStatus === "error";
  const paused = !health.isActive;

  // Confirmation gates. The handlers above are unchanged; these only ask first.
  async function onToggleActive() {
    if (!paused) {
      const ok = await confirm({
        title: "Pause syncing this source?",
        description:
          "Scheduled syncs for this source stop until you resume it. Knowledge it has already ingested is not removed.",
        confirmLabel: "Pause",
      });
      if (!ok) return;
    }
    await toggleActive();
  }

  async function onRepairDates() {
    const ok = await confirm({
      title: "Repair call dates for the whole organisation?",
      description: "This rewrites call dates across every source, not just this one.",
      confirmLabel: "Repair dates",
    });
    if (ok) await repairDates();
  }

  async function onBackfill() {
    const ok = await confirm({
      title: "Back-fill call transcripts?",
      description:
        "This fetches and stores the raw transcript of every past call from this source. It can take a while; transcripts that are already stored are skipped.",
      confirmLabel: "Back-fill",
    });
    if (ok) await backfillTranscripts();
  }

  // P0: a source that has never completed a sync is not "Connected" (and not green).
  const hasSucceeded = Boolean(health.lastSuccessAt) || health.lastStatus === "success";
  const neverSynced = !health.lastStatus || !hasSucceeded;
  const running = runs[0]?.status === "running" || health.lastStatus === "running";
  const partial = runs[0]?.status === "success" && /^partial:/i.test(runs[0]?.error ?? "");
  const scheduled = runs.some(r => r.trigger === "schedule");

  const syncState: { label: string; tone: BadgeTone } = errorState
    ? { label: "Last sync failed", tone: "danger" }
    : running
      ? { label: "Syncing", tone: "accent" }
      : partial
        ? { label: "Reconciliation continues", tone: "warning" }
        : neverSynced
        ? { label: "Never synced", tone: "neutral" }
        : { label: "Last batch succeeded", tone: "success" };

  const connection: { value: string; tone: StatTone; icon: LucideIcon } = paused
    ? { value: "Paused", tone: "neutral", icon: Pause }
    : errorState
      ? { value: "Error", tone: "danger", icon: AlertTriangle }
      : running
        ? { value: "Syncing", tone: "default", icon: Radio }
        : neverSynced
          ? { value: "Never synced", tone: "neutral", icon: CircleDashed }
          : { value: "Connected", tone: "success", icon: CheckCircle2 };

  const kindLabel = health.kind === "pull_http" ? "API sync connector" : humanize(health.kind);
  const description = [
    sourceTypeLabel(health.sourceType),
    kindLabel,
    health.scheduleCron ? `Schedule ${health.scheduleCron}` : scheduled ? "Automatic reconciliation and event updates" : "Manual or webhook syncs",
  ].join(" · ");

  const busyLabel = repairing ? "Repairing call dates…" : backfilling ? "Back-filling transcripts…" : null;

  const moreItems: MenuItem[] =
    health.kind === "pull_http"
      ? [
          { label: "Repair call dates", icon: CalendarCheck, onSelect: onRepairDates, disabled: repairing },
          { label: "Back-fill transcripts", icon: ScrollText, onSelect: onBackfill, disabled: backfilling },
        ]
      : [];

  return (
    <div className="space-y-5">
      <PageHeader
        title={health.name}
        description={description}
        backHref="/dashboard/sources"
        backLabel="Sources"
        className="mb-0"
        actions={
          <>
            <Button size="toolbar" onClick={syncNow} loading={syncing}>
              {!syncing && <RefreshCw size={14} aria-hidden />}
              {syncing ? "Syncing…" : errorState ? "Retry sync" : "Sync now"}
            </Button>
            <Button variant="secondary" size="toolbar" onClick={onToggleActive} loading={toggling}>
              {!toggling && (paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />)}
              {paused ? "Resume sync" : "Pause sync"}
            </Button>
            {moreItems.length > 0 && (
              <Menu
                label="More source actions"
                items={moreItems}
                width={220}
                triggerClassName="border border-border bg-surface"
              />
            )}
          </>
        }
      >
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge tone={syncState.tone} dot>
            {syncState.label}
          </Badge>
          {paused && <Badge tone="neutral">Paused</Badge>}
          <span role="status" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            {busyLabel && (
              <>
                <Loader2 size={12} aria-hidden className="animate-spin" />
                {busyLabel}
              </>
            )}
          </span>
        </div>
      </PageHeader>

      {msg && (
        <Alert tone={msg.tone} onDismiss={() => setMsg(null)}>
          {msg.text}
        </Alert>
      )}

      {/* Sync state */}
      <StatGrid cols={4}>
        <StatTile
          icon={connection.icon}
          tone={connection.tone}
          label="Connection"
          value={connection.value}
          hint={AUTH_LABELS[health.authType] ?? `${humanize(health.authType)} auth`}
        />
        <StatTile
          icon={health.lastSuccessAt ? CheckCircle2 : CircleDashed}
          tone={health.lastSuccessAt ? "success" : "default"}
          label="Last completed batch"
          value={<TimeAgo iso={health.lastSuccessAt} />}
          hint={health.lastSuccessAt ? "A batch may cover part of the source" : "No successful batch yet"}
        />
        <StatTile
          icon={Clock}
          label="Last attempted"
          value={<TimeAgo iso={health.lastRunAt} />}
          hint={health.scheduleCron ? `Schedule: ${health.scheduleCron}` : scheduled ? "Automatic reconciliation observed" : "Manual or event-driven"}
        />
        <StatTile
          icon={Gauge}
          label="Average batch duration"
          value={fmtDuration(health.avgSyncDurationMs)}
          hint="Run time; not live update latency"
        />
      </StatGrid>

      {/* Throughput */}
      <StatGrid cols={3}>
        <StatTile
          icon={Radio}
          label="Records ingested"
          value={fmtInt(health.totalIngested)}
          hint="Across recent runs"
        />
        <StatTile
          icon={GitCommitHorizontal}
          label="Chunks embedded"
          value={fmtInt(health.totalChunks)}
          hint="Searchable pieces"
        />
        <StatTile
          icon={AlertTriangle}
          tone="default"
          label="Already stored"
          value={fmtInt(health.totalSkipped)}
          hint="No new content to ingest"
        />
      </StatGrid>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard icon={Plug} title="Connection and checkpoint">
          <dl className="grid grid-cols-[160px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
            <Row label="Endpoint">
              {health.endpointUrl ? (
                <code className="break-all font-mono text-xs">
                  {health.httpMethod} {health.endpointUrl}
                </code>
              ) : (
                <Muted>—</Muted>
              )}
            </Row>
            <Row label="Sync cursor field">{health.cursorField || <Muted>—</Muted>}</Row>
            <Row label="Last checkpoint">
              {health.cursorValue ? (
                <code className="break-all font-mono text-xs">{health.cursorValue}</code>
              ) : (
                <Muted>Not set yet</Muted>
              )}
            </Row>
            <Row label="Incremental param">{health.cursorParam || <Muted>—</Muted>}</Row>
          </dl>
        </SectionCard>

        <SectionCard icon={Workflow} title="Ingestion mapping">
          <dl className="grid grid-cols-[160px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
            <Row label="Records path">
              {health.recordsPath ? (
                <code className="break-all font-mono text-xs">{health.recordsPath}</code>
              ) : (
                <Muted>—</Muted>
              )}
            </Row>
            <Row label="Record id field">{health.recordIdField || <Muted>—</Muted>}</Row>
            <Row label="Source type">{sourceTypeLabel(health.sourceType)}</Row>
            <Row label="Schedule">{health.scheduleCron || <Muted>{scheduled ? "Automatic reconciliation observed in recent runs" : "Manual or webhook"}</Muted>}</Row>
          </dl>
        </SectionCard>
      </div>

      {/* Run history */}
      <TableCard title="Sync history" meta="Recent runs, newest first">
        <Table minWidth={720} caption="Sync history">
          <THead>
            <tr>
              <Th>Started</Th>
              <Th>Trigger</Th>
              <Th>Status</Th>
              <Th numeric>Ingested</Th>
              <Th numeric>Chunks</Th>
              <Th numeric>Skipped</Th>
              <Th numeric>Duration</Th>
            </tr>
          </THead>
          <TBody>
            {runs.length === 0 ? (
              <TableEmptyRow colSpan={7}>No syncs yet. Use Sync now to pull the first batch.</TableEmptyRow>
            ) : (
              runs.map((r, i) => {
                const dur = r.finishedAt ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime() : null;
                const runPartial = r.status === "success" && /^partial:/i.test(r.error ?? "");
                const errorSummary = runPartial ? "Batch saved. The next sync resumes from the checkpoint." : ingestionErrorSummary(r.error);
                return (
                  <Tr key={i}>
                    <Td className="whitespace-nowrap align-top text-muted-foreground">
                      <TimeAgo iso={r.startedAt || null} />
                    </Td>
                    <Td className="whitespace-nowrap align-top text-muted-foreground">
                      {triggerLabel(r.trigger)}
                    </Td>
                    <Td className="align-top">
                      <div className="flex max-w-[44ch] flex-col items-start gap-1">
                        <Badge tone={runPartial ? "warning" : statusTone(r.status)}>{runPartial ? "Batch saved · more to check" : RUN_STATUS_LABELS[r.status] ?? humanize(r.status)}</Badge>
                        {r.error && (
                          <details className="group w-full text-xs text-muted-foreground">
                            <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md [&::-webkit-details-marker]:hidden">
                              <ChevronRight
                                size={12}
                                aria-hidden
                                className="shrink-0 transition-transform group-open:rotate-90"
                              />
                              <span className="truncate">{errorSummary}</span>
                            </summary>
                            <p className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-muted/50 px-2 py-1.5 text-xs">
                              {errorSummary}
                            </p>
                          </details>
                        )}
                      </div>
                    </Td>
                    <Td numeric className="align-top">{fmtInt(r.ingested)}</Td>
                    <Td numeric className="align-top">{fmtInt(r.chunks)}</Td>
                    <Td numeric className="align-top">{fmtInt(r.skipped)}</Td>
                    <Td numeric className="align-top text-muted-foreground">{fmtDuration(dur)}</Td>
                  </Tr>
                );
              })
            )}
          </TBody>
        </Table>
      </TableCard>

      {dialog}
    </div>
  );
}
