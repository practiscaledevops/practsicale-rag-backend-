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
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
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
} from "@/components/ui";
import { fmtDateTime, fmtDuration, humanize, relTime } from "@/lib/format";
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
const COLS = 9; // table columns, for the expandable error row colSpan


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
          <Table minWidth={960} caption="Processing runs">
            <THead>
              <tr>
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
                return (
                  <React.Fragment key={r.id}>
                    <Tr>
                      <Td className="whitespace-nowrap font-medium">
                        <TimeAgo iso={r.started_at} />
                      </Td>
                      <Td>{sourceCell(r)}</Td>
                      <Td>
                        <Badge tone="neutral">{triggerLabel(r.trigger)}</Badge>
                      </Td>
                      <Td>
                        <StatusPill status={r.status} />
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
    </div>
  );
}
