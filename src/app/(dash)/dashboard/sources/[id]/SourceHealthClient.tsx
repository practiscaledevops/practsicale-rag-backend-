"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  RefreshCw,
  Pause,
  Play,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Radio,
  Clock,
  GitCommitHorizontal,
  Gauge,
  ScrollText,
  CalendarCheck,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import { Card, CardContent } from "@/components/ui/Card";
import { Table, THead, TBody, Tr, Th, Td } from "@/components/ui/Table";
import { cn } from "@/lib/utils";

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
  avgTimeToSearchableMs: number | null;
}

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

function duration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function SourceHealthClient({ health, runs }: { health: SourceHealth; runs: SourceRun[] }) {
  const router = useRouter();
  const [syncing, setSyncing] = React.useState(false);
  const [toggling, setToggling] = React.useState(false);
  const [backfilling, setBackfilling] = React.useState(false);
  const [repairing, setRepairing] = React.useState(false);
  const [msg, setMsg] = React.useState<{ tone: "success" | "danger"; text: string } | null>(null);

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
      setMsg({ tone: "success", text: `Sync complete — ${found} new record${found === 1 ? "" : "s"} ingested.` });
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

  return (
    <div className="space-y-6">
      <Link href="/dashboard/sources" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Knowledge sources
      </Link>

      {/* Header + controls */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{health.name}</h1>
            <Badge tone={paused ? "warning" : "success"}>{paused ? "Paused" : "Active"}</Badge>
            {errorState && <Badge tone="danger">Last sync failed</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {health.sourceType.replace(/_/g, " ")} · {health.kind === "pull_http" ? "API sync connector" : health.kind}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={toggleActive} disabled={toggling}>
            {toggling ? <Loader2 className="h-4 w-4 animate-spin" /> : paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            {paused ? "Resume sync" : "Pause sync"}
          </Button>
          {health.kind === "pull_http" && (
            <Button variant="outline" size="sm" onClick={backfillTranscripts} disabled={backfilling} title="Fetch and store every past call's raw transcript">
              {backfilling ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScrollText className="h-4 w-4" />}
              {backfilling ? "Back-filling…" : "Back-fill transcripts"}
            </Button>
          )}
          {health.kind === "pull_http" && (
            <Button variant="outline" size="sm" onClick={repairDates} disabled={repairing} title="Align every stored call date with the scoring app (fixes blank / mis-dated calls)">
              {repairing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarCheck className="h-4 w-4" />}
              {repairing ? "Repairing…" : "Repair call dates"}
            </Button>
          )}
          <Button size="sm" onClick={syncNow} disabled={syncing}>
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {syncing ? "Syncing…" : errorState ? "Retry sync" : "Sync now"}
          </Button>
        </div>
      </div>

      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      {/* Sync state */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={health.lastStatus === "success" ? CheckCircle2 : errorState ? AlertTriangle : Radio}
          tone={health.lastStatus === "success" ? "ok" : errorState ? "bad" : "muted"}
          label="Connection"
          value={paused ? "Paused" : errorState ? "Error" : "Connected"}
          hint={health.authType === "none" ? "no auth" : `${health.authType} auth`}
        />
        <StatCard icon={CheckCircle2} tone="ok" label="Last successful sync" value={relTime(health.lastSuccessAt)} hint={health.lastSuccessAt ? new Date(health.lastSuccessAt).toLocaleString() : "—"} />
        <StatCard icon={Clock} tone="muted" label="Last attempted" value={relTime(health.lastRunAt)} hint={health.scheduleCron ? `schedule: ${health.scheduleCron}` : "manual only"} />
        <StatCard icon={Gauge} tone="muted" label="Avg time to searchable" value={duration(health.avgTimeToSearchableMs)} hint="call → embedded" />
      </div>

      {/* Throughput */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard icon={Radio} tone="ok" label="Records ingested" value={health.totalIngested.toLocaleString()} hint="across recent runs" />
        <StatCard icon={GitCommitHorizontal} tone="muted" label="Chunks embedded" value={health.totalChunks.toLocaleString()} hint="searchable pieces" />
        <StatCard icon={AlertTriangle} tone={health.totalSkipped > 0 ? "warn" : "muted"} label="Skipped as duplicates" value={health.totalSkipped.toLocaleString()} hint="idempotent by content hash" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Checkpoint + connection */}
        <Card>
          <CardContent className="p-5">
            <h2 className="mb-3 text-base font-semibold">Connection &amp; checkpoint</h2>
            <dl className="space-y-2.5 text-sm">
              <Row label="Endpoint">{health.endpointUrl ? <code className="break-all text-xs">{health.httpMethod} {health.endpointUrl}</code> : "—"}</Row>
              <Row label="Sync cursor field">{health.cursorField || "—"}</Row>
              <Row label="Last checkpoint">{health.cursorValue ? <code className="break-all text-xs">{health.cursorValue}</code> : <span className="text-muted-foreground">not yet set</span>}</Row>
              <Row label="Incremental param">{health.cursorParam || "—"}</Row>
            </dl>
          </CardContent>
        </Card>

        {/* Field mapping */}
        <Card>
          <CardContent className="p-5">
            <h2 className="mb-3 text-base font-semibold">Ingestion mapping</h2>
            <dl className="space-y-2.5 text-sm">
              <Row label="Records path">{health.recordsPath ? <code className="text-xs">{health.recordsPath}</code> : "—"}</Row>
              <Row label="Record id field">{health.recordIdField || "—"}</Row>
              <Row label="Source type">{health.sourceType.replace(/_/g, " ")}</Row>
              <Row label="Schedule">{health.scheduleCron || "manual / webhook only"}</Row>
            </dl>
          </CardContent>
        </Card>
      </div>

      {/* Run history */}
      <Card>
        <CardContent className="p-0">
          <div className="border-b border-border p-5">
            <h2 className="text-base font-semibold">Sync history</h2>
            <p className="text-xs text-muted-foreground">Recent runs, newest first. Errors show the failure reason.</p>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>Started</Th>
                  <Th>Trigger</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Ingested</Th>
                  <Th className="text-right">Chunks</Th>
                  <Th className="text-right">Skipped</Th>
                  <Th>Duration</Th>
                </Tr>
              </THead>
              <TBody>
                {runs.length === 0 ? (
                  <Tr>
                    <Td className="py-8 text-center text-muted-foreground" colSpan={7}>
                      No syncs yet. Run “Sync now” to pull the first batch.
                    </Td>
                  </Tr>
                ) : (
                  runs.map((r, i) => {
                    const dur = r.finishedAt ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime() : null;
                    return (
                      <Tr key={i}>
                        <Td className="whitespace-nowrap text-muted-foreground">{new Date(r.startedAt).toLocaleString()}</Td>
                        <Td className="capitalize text-muted-foreground">{r.trigger}</Td>
                        <Td>
                          <Badge tone={r.status === "success" ? "success" : r.status === "error" ? "danger" : "warning"}>{r.status}</Badge>
                          {r.error && <span className="ml-2 text-xs text-danger" title={r.error}>{r.error.slice(0, 40)}</span>}
                        </Td>
                        <Td className="text-right tabular-nums">{r.ingested.toLocaleString()}</Td>
                        <Td className="text-right tabular-nums">{r.chunks.toLocaleString()}</Td>
                        <Td className="text-right tabular-nums">{r.skipped.toLocaleString()}</Td>
                        <Td className="whitespace-nowrap text-muted-foreground">{duration(dur)}</Td>
                      </Tr>
                    );
                  })
                )}
              </TBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  icon: Icon,
  tone,
  label,
  value,
  hint,
}: {
  icon: typeof CheckCircle2;
  tone: "ok" | "bad" | "warn" | "muted";
  label: string;
  value: string;
  hint: string;
}) {
  const iconCls =
    tone === "ok" ? "bg-emerald-500/15 text-emerald-500" : tone === "bad" ? "bg-rose-500/15 text-rose-500" : tone === "warn" ? "bg-amber-500/15 text-amber-500" : "bg-surface-muted text-muted-foreground";
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs text-muted-foreground">{label}</p>
          <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-lg", iconCls)}>
            <Icon className="h-4 w-4" aria-hidden />
          </span>
        </div>
        <p className="mt-1.5 text-xl font-semibold tabular-nums">{value}</p>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium">{children}</dd>
    </div>
  );
}
