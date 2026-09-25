"use client";

// Processing monitor — a layman-readable view of ingestion runs.
//
// The server component seeds `initialRuns` (SSR). This client then keeps them
// fresh by polling GET /api/admin/runs every ~10s (toggleable) and via a manual
// Refresh button. The summary header and table are derived purely from the runs
// array, so a poll update re-renders everything consistently.

import * as React from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  FileText,
  Inbox,
  Layers,
  Loader2,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  BulkActionBar,
  EmptyState,
  RowSelectCell,
  SelectAllCell,
  SELECTED_ROW_CLASS,
  StatGrid,
  StatTile,
  Switch,
  Table,
  TableCard,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  buttonClass,
  useBulkRun,
  useConfirm,
  usePendingIds,
  useSelection,
} from "@/components/ui";
import { BULK_CONCURRENCY, bulkErrorMessage, requestJson, type BulkVerbs } from "@/lib/bulk";
import { fmtDateTime, fmtDuration, fmtInt as fmtCount, humanize, relTime } from "@/lib/format";
import { statusTone, triggerLabel } from "@/lib/ui-labels";
import { cn } from "@/lib/utils";

/** One ingestion run, as returned by /api/admin/runs and the Processing page. */
export interface RunRow {
  id: string;
  data_source_id: string | null;
  /** Resolved name of the data source, or null for uploads / unknown. */
  source_name: string | null;
  trigger: string; // manual | schedule | webhook | upload
  status: string; // running | success | error
  documents_ingested: number;
  chunks_ingested: number;
  documents_skipped: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

const POLL_MS = 10_000;
const COLS = 10; // table columns, for the expandable error row colSpan
const SYNC_VERBS: BulkVerbs = { running: "Syncing", done: "synced" };

/** A failed run of a pull source: the only rows that can be retried from here. */
const isRetryable = (r: RunRow) => r.status === "error" && !!r.data_source_id;

/** How one source's retry went, shown on its failed runs. */
interface RetryMsg {
  tone: "success" | "danger";
  text: string;
}


const STATUS_LABELS: Record<string, string> = {
  success: "Succeeded",
  error: "Failed",
};

const fmtInt = (n: number) => (n ?? 0).toLocaleString();

/** Table links: foreground text, accent on hover. */
const tableLink = "font-medium text-foreground hover:text-accent-strong hover:underline";

// true only after hydration, so locale-dependent strings never mismatch the server HTML.
const noopSubscribe = () => () => {};
function useHydrated() {
  return React.useSyncExternalStore(noopSubscribe, () => true, () => false);
}

/** Relative time ("5m ago") with the exact local date and time in its tooltip. */
function TimeAgo({ iso }: { iso: string }) {
  const hydrated = useHydrated();
  return (
    <time dateTime={iso} title={hydrated ? fmtDateTime(iso) : undefined} suppressHydrationWarning>
      {relTime(iso, { never: "—", absolute: hydrated })}
    </time>
  );
}

/** Status: running is in progress (accent, spinner); the rest use the shared tones. */
function StatusPill({ status }: { status: string }) {
  if (status === "running") {
    return (
      <Badge tone="accent">
        <Loader2 size={12} className="animate-spin" aria-hidden="true" />
        Running
      </Badge>
    );
  }
  return <Badge tone={statusTone(status)}>{STATUS_LABELS[status] ?? humanize(status)}</Badge>;
}

function sourceCell(run: RunRow): React.ReactNode {
  if (run.source_name && run.data_source_id) {
    return (
      <Link href={`/dashboard/sources/${run.data_source_id}`} className={tableLink}>
        {run.source_name}
      </Link>
    );
  }
  if (run.source_name) return <span className="font-medium">{run.source_name}</span>;
  if (run.trigger === "upload") return <span className="font-medium">Upload</span>;
  return <span className="text-muted-foreground">—</span>;
}

export function ProcessingClient({ initialRuns }: { initialRuns: RunRow[] }) {
  const [runs, setRuns] = React.useState<RunRow[]>(initialRuns);
  const [auto, setAuto] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [pollError, setPollError] = React.useState<string | null>(null);
  // null until the first client-side refresh, to avoid an SSR hydration mismatch.
  const [lastUpdated, setLastUpdated] = React.useState<Date | null>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const autoId = React.useId();

  const refresh = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/admin/runs", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
      setRuns((json.runs as RunRow[]) ?? []);
      setPollError(null);
      setLastUpdated(new Date());
    } catch (e) {
      // Keep showing the last good data; surface a non-blocking warning.
      setPollError(e instanceof Error ? e.message : "Failed to refresh");
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Auto-refresh loop (paused when `auto` is off).
  React.useEffect(() => {
    if (!auto) return;
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [auto, refresh]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // --- Bulk: select failed runs → re-sync their sources ----------------------
  // Each sync can run for minutes, so the sources go one at a time over the
  // single sync endpoint; the monitor keeps polling and stays usable meanwhile.
  const { confirm, dialog } = useConfirm();
  const retryRun = useBulkRun();
  const syncing = usePendingIds(); // source ids whose sync request is in flight
  const [retryMsg, setRetryMsg] = React.useState<Record<string, RetryMsg>>({});
  const sel = useSelection(runs.filter(isRetryable).map((r) => r.id));
  const hydrated = useHydrated();
  const runsRef = React.useRef(runs);
  React.useEffect(() => {
    runsRef.current = runs;
  }, [runs]);

  // The distinct sources behind the selected runs (a source can fail many times).
  const selected = sel.selected;
  const selectedSources = React.useMemo(() => {
    const ids = new Set<string>();
    for (const r of runs) if (selected.has(r.id) && r.data_source_id) ids.add(r.data_source_id);
    return Array.from(ids);
  }, [runs, selected]);

  async function syncSource(sourceId: string) {
    setRetryMsg((prev) => {
      if (!(sourceId in prev)) return prev;
      const next = { ...prev };
      delete next[sourceId];
      return next;
    });
    try {
      // No abort signal: the pull keeps running server-side, so an in-flight
      // sync still reports its result after Cancel.
      const r = await requestJson<{ status?: string; error?: string } | null>(
        `/api/admin/sources/${encodeURIComponent(sourceId)}/sync`,
        { method: "POST" }
      );
      if (r?.status === "error") throw new Error(r.error || "Sync failed");
      setRetryMsg((prev) => ({ ...prev, [sourceId]: { tone: "success", text: "Re-synced" } }));
    } catch (e) {
      const text = e instanceof TypeError ? "Network error — please try again." : bulkErrorMessage(e, "Sync failed");
      setRetryMsg((prev) => ({ ...prev, [sourceId]: { tone: "danger", text } }));
      throw new Error(text);
    }
  }

  async function retrySelected() {
    const sources = selectedSources;
    if (sources.length === 0) return;
    if (sources.length > 1) {
      const ok = await confirm({
        title: `Sync ${fmtCount(sources.length)} sources again?`,
        description:
          "They sync one at a time, and each can take up to 5 minutes. Keep this page open until they finish; you can cancel between syncs.",
        confirmLabel: `Sync ${fmtCount(sources.length)}`,
      });
      if (!ok) return;
    }
    await retryRun.run(
      sources,
      async (sourceId) => {
        let ran = false;
        await syncing.run(sourceId, () => {
          ran = true;
          return syncSource(sourceId);
        });
        if (!ran) throw new Error("Already syncing");
      },
      {
        concurrency: BULK_CONCURRENCY.sync,
        verbs: SYNC_VERBS,
        onSettled: (res) => {
          // Runs whose source re-synced are dealt with and leave the selection. The
          // rest (failed again, or cancelled), and anything the admin (de)selected
          // during the run, keep their current state: `select` applies to the live
          // selection, not the one captured when the run started.
          const ok = new Set(res.ok);
          sel.select(
            runsRef.current.filter((r) => r.data_source_id && ok.has(r.data_source_id)).map((r) => r.id),
            false
          );
          void refresh(); // pick up the new runs now instead of at the next poll
        },
      }
    );
  }

  // Summary over the shown window.
  const summary = React.useMemo(() => {
    let docs = 0;
    let chunks = 0;
    let errors = 0;
    let running = 0;
    for (const r of runs) {
      docs += r.documents_ingested ?? 0;
      chunks += r.chunks_ingested ?? 0;
      if (r.status === "error") errors += 1;
      if (r.status === "running") running += 1;
    }
    return { docs, chunks, errors, running, count: runs.length };
  }, [runs]);

  return (
    <div className="space-y-5">
      {/* Summary header */}
      <StatGrid cols={4}>
        <StatTile icon={Activity} label="Runs shown" value={fmtInt(summary.count)} />
        <StatTile icon={FileText} label="Documents ingested" value={fmtInt(summary.docs)} />
        <StatTile icon={Layers} label="Chunks ingested" value={fmtInt(summary.chunks)} />
        <StatTile
          icon={AlertTriangle}
          tone={summary.errors > 0 ? "danger" : "default"}
          label="Errors"
          value={fmtInt(summary.errors)}
        />
      </StatGrid>

      {pollError && (
        <Alert tone="warning" title="Couldn't refresh">
          {pollError} — showing the last loaded data.
        </Alert>
      )}

      {/* Runs table */}
      <TableCard
        title="Runs"
        meta={
          <span className="inline-flex flex-wrap items-center gap-x-2">
            {summary.running > 0 && (
              <span className="inline-flex items-center gap-1.5 font-medium text-accent-strong">
                <span aria-hidden className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75 motion-reduce:animate-none" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
                </span>
                {summary.running} running
              </span>
            )}
            {lastUpdated
              ? `Updated ${lastUpdated.toLocaleTimeString()}`
              : "Auto-refreshing every 10s"}
          </span>
        }
        actions={
          <>
            <div className="flex items-center gap-2">
              <label id={`${autoId}-label`} htmlFor={autoId} className="cursor-pointer text-[13px] text-foreground">
                Auto-refresh
              </label>
              <Switch
                id={autoId}
                checked={auto}
                onChange={setAuto}
                label="Auto-refresh"
                aria-labelledby={`${autoId}-label`}
              />
            </div>
            <Button variant="secondary" size="toolbar" onClick={refresh} disabled={refreshing}>
              <RefreshCw
                size={14}
                className={cn(refreshing && "animate-spin")}
                aria-hidden="true"
              />
              Refresh
            </Button>
          </>
        }
      >
        {runs.length === 0 ? (
          <EmptyState
            variant="plain"
            icon={Inbox}
            title="No processing activity yet"
            description="Syncs and uploads will appear here as soon as they run."
            action={
              <Link href="/dashboard/sources" className={buttonClass({ variant: "secondary", size: "toolbar" })}>
                Go to Sources
              </Link>
            }
          />
        ) : (
          // `relative`: the checkboxes' hidden parts stay inside the table's own scroller.
          <Table minWidth={1000} caption="Processing runs" wrapperClassName="relative">
            <THead>
              <tr>
                <SelectAllCell {...sel.selectAllProps} label="Select all failed source runs" />
                <Th>When</Th>
                <Th>Source</Th>
                <Th>Trigger</Th>
                <Th>Status</Th>
                <Th numeric>Docs</Th>
                <Th numeric>Chunks</Th>
                <Th numeric>Skipped</Th>
                <Th numeric>Duration</Th>
                <Th>Error</Th>
              </tr>
            </THead>
            <TBody>
              {runs.map((r) => {
                const isOpen = expanded.has(r.id);
                const errorId = `run-${r.id}-error`;
                const retryable = isRetryable(r);
                const sourceId = r.data_source_id ?? "";
                const inFlight = retryable && syncing.isPending(sourceId);
                const queued = retryable && !inFlight && retryRun.isActive(sourceId);
                const msg = retryable ? retryMsg[sourceId] : undefined;
                return (
                  <React.Fragment key={r.id}>
                    <Tr className={cn(sel.isSelected(r.id) && SELECTED_ROW_CLASS)}>
                      {retryable ? (
                        <RowSelectCell
                          {...sel.rowProps(r.id)}
                          label={`Select failed run of ${r.source_name ?? "this source"} from ${
                            hydrated ? fmtDateTime(r.started_at) : r.started_at
                          }`}
                        />
                      ) : (
                        <Td className="w-10 p-0" />
                      )}
                      <Td className="whitespace-nowrap font-medium">
                        <TimeAgo iso={r.started_at} />
                      </Td>
                      <Td>{sourceCell(r)}</Td>
                      <Td>
                        <Badge tone="neutral">{triggerLabel(r.trigger)}</Badge>
                      </Td>
                      <Td>
                        <div className="flex flex-wrap items-center gap-1">
                          <StatusPill status={r.status} />
                          {inFlight ? (
                            <Badge tone="accent">
                              <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                              Re-syncing
                            </Badge>
                          ) : queued ? (
                            <Badge tone="neutral">Queued</Badge>
                          ) : msg?.tone === "success" ? (
                            <Badge tone="success">{msg.text}</Badge>
                          ) : null}
                        </div>
                        {msg?.tone === "danger" && !inFlight && !queued && (
                          <p className="mt-1 max-w-[32ch] break-words text-xs text-danger-ink">
                            Retry failed: {msg.text}
                          </p>
                        )}
                      </Td>
                      <Td numeric>{fmtInt(r.documents_ingested)}</Td>
                      <Td numeric>{fmtInt(r.chunks_ingested)}</Td>
                      <Td numeric>
                        {r.documents_skipped > 0 ? (
                          fmtInt(r.documents_skipped)
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </Td>
                      <Td numeric className="text-muted-foreground">
                        {r.finished_at
                          ? fmtDuration(Math.max(0, new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()))
                          : "—"}
                      </Td>
                      <Td className="py-1">
                        {r.error ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => toggle(r.id)}
                            aria-expanded={isOpen}
                            aria-controls={isOpen ? errorId : undefined}
                            className="max-w-[24ch] px-2 text-danger hover:bg-danger/10"
                          >
                            <ChevronRight
                              size={14}
                              className={cn("shrink-0 transition-transform", isOpen && "rotate-90")}
                              aria-hidden="true"
                            />
                            <span className="truncate">{r.error}</span>
                          </Button>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </Td>
                    </Tr>
                    {r.error && isOpen && (
                      <tr id={errorId}>
                        <td colSpan={COLS} className="bg-danger/5 px-4 py-2.5">
                          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-danger">
                            {r.error}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </TBody>
          </Table>
        )}
      </TableCard>

      <BulkActionBar
        count={sel.count}
        onClear={sel.clear}
        run={retryRun}
        noun={["failed run", "failed runs"]}
        actions={[
          {
            key: "retry-sync",
            label:
              selectedSources.length === 1
                ? "Retry sync"
                : `Retry sync · ${fmtCount(selectedSources.length)} sources`,
            icon: RotateCcw,
            tone: "primary",
            onClick: () => void retrySelected(),
            disabled: selectedSources.length === 0,
            title: "Runs a new sync for each selected run's source, one at a time",
          },
        ]}
      />
      {dialog}
    </div>
  );
}
