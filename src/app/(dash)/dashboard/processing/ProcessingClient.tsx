"use client";

// Processing monitor — a layman-readable view of ingestion runs.
//
// The server component seeds `initialRuns` (SSR). This client then keeps them
// fresh by polling GET /api/admin/runs every ~10s (toggleable) and via a manual
// Refresh button. The summary header and table are derived purely from the runs
// array, so a poll update re-renders everything consistently.

import * as React from "react";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileText,
  Inbox,
  Layers,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Card, CardContent } from "@/components/ui/Card";
import { Table, THead, TBody, Tr, Th, Td } from "@/components/ui/Table";
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
const COLS = 8; // table columns, for the expandable error row colSpan

const TRIGGER_LABELS: Record<string, string> = {
  manual: "Manual sync",
  schedule: "Scheduled",
  webhook: "Webhook",
  upload: "Upload",
};
const triggerLabel = (v: string) => TRIGGER_LABELS[v] ?? v;

const fmtInt = (n: number) => (n ?? 0).toLocaleString();

/** Human duration between start and finish (finished rows only — always stable). */
function fmtDuration(startIso: string, endIso: string): string {
  const ms = Math.max(0, new Date(endIso).getTime() - new Date(startIso).getTime());
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

/** Status pill: running (amber, spinner), success (green), error (red). */
function StatusPill({ status }: { status: string }) {
  if (status === "running") {
    return (
      <Badge tone="warning" className="gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        Running
      </Badge>
    );
  }
  if (status === "error") return <Badge tone="danger">Error</Badge>;
  if (status === "success") return <Badge tone="success">Success</Badge>;
  return <Badge tone="neutral">{status}</Badge>;
}

function sourceCell(run: RunRow): React.ReactNode {
  if (run.source_name) return run.source_name;
  if (run.trigger === "upload") return "Upload";
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

  const stats = [
    { label: "Runs shown", value: fmtInt(summary.count), icon: Activity, alert: false },
    { label: "Documents ingested", value: fmtInt(summary.docs), icon: FileText, alert: false },
    { label: "Chunks ingested", value: fmtInt(summary.chunks), icon: Layers, alert: false },
    {
      label: "Errors",
      value: fmtInt(summary.errors),
      icon: AlertTriangle,
      alert: summary.errors > 0,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Summary header */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(({ label, value, icon: Icon, alert }) => (
          <Card key={label}>
            <CardContent className="flex items-center justify-between p-5">
              <div className="min-w-0">
                <p className="text-sm text-muted-foreground">{label}</p>
                <p
                  className={cn(
                    "mt-1 text-2xl font-semibold tabular-nums",
                    alert && "text-danger"
                  )}
                >
                  {value}
                </p>
              </div>
              <div
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-lg bg-surface-muted text-muted-foreground",
                  alert && "bg-danger/10 text-danger"
                )}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {summary.running > 0 && (
            <span className="mr-2 inline-flex items-center gap-1.5 font-medium text-warning">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-warning" />
              </span>
              {summary.running} running
            </span>
          )}
          {lastUpdated
            ? `Updated ${lastUpdated.toLocaleTimeString()}`
            : "Auto-refreshing every 10s"}
        </p>

        <div className="flex items-center gap-2">
          <Button
            variant={auto ? "secondary" : "outline"}
            size="sm"
            onClick={() => setAuto((a) => !a)}
            aria-pressed={auto}
          >
            {auto ? "Auto-refresh: On" : "Auto-refresh: Off"}
          </Button>
          <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
            <RefreshCw
              className={cn("h-4 w-4", refreshing && "animate-spin")}
              aria-hidden="true"
            />
            Refresh
          </Button>
        </div>
      </div>

      {pollError && (
        <Alert tone="warning" title="Could not refresh">
          {pollError} — showing the last loaded data.
        </Alert>
      )}

      {/* Runs table */}
      {runs.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No processing activity yet"
          description="Syncs and uploads will appear here as soon as they run."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <THead>
                <Tr>
                  <Th>When</Th>
                  <Th>Source</Th>
                  <Th>Trigger</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Docs</Th>
                  <Th className="text-right">Chunks</Th>
                  <Th className="text-right">Skipped</Th>
                  <Th>Error</Th>
                </Tr>
              </THead>
              <TBody>
                {runs.map((r) => {
                  const isOpen = expanded.has(r.id);
                  return (
                    <React.Fragment key={r.id}>
                      <Tr>
                        <Td className="whitespace-nowrap">
                          <div className="font-medium">
                            {new Date(r.started_at).toLocaleString()}
                          </div>
                          {r.finished_at && (
                            <div className="text-xs text-muted-foreground">
                              took {fmtDuration(r.started_at, r.finished_at)}
                            </div>
                          )}
                        </Td>
                        <Td className="font-medium">{sourceCell(r)}</Td>
                        <Td>
                          <Badge tone="neutral">{triggerLabel(r.trigger)}</Badge>
                        </Td>
                        <Td>
                          <StatusPill status={r.status} />
                        </Td>
                        <Td className="text-right tabular-nums">
                          {fmtInt(r.documents_ingested)}
                        </Td>
                        <Td className="text-right tabular-nums">
                          {fmtInt(r.chunks_ingested)}
                        </Td>
                        <Td className="text-right tabular-nums">
                          {r.documents_skipped > 0 ? (
                            fmtInt(r.documents_skipped)
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </Td>
                        <Td>
                          {r.error ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => toggle(r.id)}
                              aria-expanded={isOpen}
                              className="max-w-[24ch] text-danger"
                            >
                              {isOpen ? (
                                <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
                              ) : (
                                <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
                              )}
                              <span className="truncate">{r.error}</span>
                            </Button>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </Td>
                      </Tr>
                      {r.error && isOpen && (
                        <Tr>
                          <Td colSpan={COLS} className="bg-danger/5">
                            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-danger">
                              {r.error}
                            </pre>
                          </Td>
                        </Tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
