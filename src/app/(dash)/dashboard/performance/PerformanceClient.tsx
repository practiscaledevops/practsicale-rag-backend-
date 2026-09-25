"use client";

import * as React from "react";
import Link from "next/link";
import { BarChart3, Headphones, Plus, RefreshCw } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  SectionCard,
  Select,
  Table,
  TableCard,
  TableSkeletonRows,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  useConfirm,
} from "@/components/ui";
import { api } from "@/components/ui/brain-ui";
import { fmtDate, fmtNumber, humanize } from "@/lib/format";

interface Metric { id: string; metric_key: string; label: string | null; value: number; unit: string | null; period_start: string | null; period_end: string | null; dimensions: Record<string, unknown>; source: string; object_id: string | null; note: string | null; created_at: string }

/** Period dates are plain days ("2026-01-31"): read them as local dates so they never shift a day. */
function fmtDay(v: string | null): string {
  if (!v) return "—";
  return fmtDate(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00` : v);
}

const LINK = "rounded-sm text-accent-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function PerformanceClient() {
  const [data, setData] = React.useState<{ metrics: Metric[]; keys: string[]; migrationMissing?: boolean } | null>(null);
  const [key, setKey] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [f, setF] = React.useState({ metricKey: "", label: "", value: "", unit: "%", periodStart: "", periodEnd: "", dimensions: "", objectRef: "", note: "" });
  const s = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const [rebuilding, setRebuilding] = React.useState(false);
  const [rebuiltMsg, setRebuiltMsg] = React.useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  async function rebuildFromCalls() {
    setRebuilding(true);
    setError(null);
    setRebuiltMsg(null);
    try {
      const r = await api<{ calls: number; consultants: number; metricsWritten: number; snapshotRef: string | null; avgScore: number; closeRate: number }>("/api/admin/knowledge/metrics/rebuild-calls", { method: "POST" });
      setRebuiltMsg(`Rebuilt from ${r.calls} calls · ${r.consultants} consultants · ${r.metricsWritten} metrics · team avg ${r.avgScore}/100, close rate ${r.closeRate}%${r.snapshotRef ? ` · snapshot ${r.snapshotRef}` : ""}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rebuild failed");
    } finally {
      setRebuilding(false);
    }
  }

  async function confirmRebuild() {
    const ok = await confirm({
      title: "Rebuild performance memory?",
      description: "Recomputes every metric from the latest call scores. This can take a minute.",
      confirmLabel: "Rebuild",
    });
    if (ok) await rebuildFromCalls();
  }

  const load = React.useCallback(async () => {
    try {
      setData(await api(`/api/admin/knowledge/metrics${key ? `?key=${encodeURIComponent(key)}` : ""}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [key]);
  React.useEffect(() => { void load(); }, [load]);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const dimensions: Record<string, string> = {};
      for (const pair of f.dimensions.split(",")) {
        const [k, v] = pair.split("=").map((x) => x.trim());
        if (k && v) dimensions[k] = v;
      }
      await api("/api/admin/knowledge/metrics", { method: "POST", body: JSON.stringify({ ...f, value: Number(f.value), dimensions }) });
      setF({ ...f, value: "", note: "" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const head = (
    <THead>
      <tr>
        <Th>Metric</Th>
        <Th>Period</Th>
        <Th numeric>Value</Th>
        <Th>Dimensions</Th>
        <Th>Source</Th>
      </tr>
    </THead>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="min-w-0 space-y-3 lg:col-span-2">
        <Card className="flex flex-wrap items-center gap-3 p-4">
          <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
            <Headphones size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-foreground">Performance from call scores</h2>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Turns scored calls into consultant entities, company, consultant and segment metrics, and a citable snapshot.
              Runs automatically after each call-scoring sync.
            </p>
          </div>
          <Button size="toolbar" loading={rebuilding} onClick={confirmRebuild}>
            {!rebuilding && <RefreshCw size={14} aria-hidden />}
            Rebuild from call scores
          </Button>
        </Card>
        {rebuiltMsg && (
          <Alert tone="success" onDismiss={() => setRebuiltMsg(null)}>
            {rebuiltMsg}
          </Alert>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <Field label="Metric" className="w-full sm:w-56">
            <Select
              density="compact"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="All metrics"
              options={(data?.keys ?? []).map((k) => ({ value: k, label: k }))}
            />
          </Field>
        </div>
        {data?.migrationMissing && (
          <Alert tone="info" title="Not enabled yet">
            <p>Performance memory isn&apos;t set up in this workspace&apos;s database yet.</p>
            <details className="mt-1">
              <summary className="cursor-pointer text-xs font-medium text-foreground">Technical details</summary>
              <p className="mt-1 text-xs">
                Apply Brain migration <code className="font-mono">0017_operating_intelligence.sql</code> to enable
                Performance Memory.
              </p>
            </details>
          </Alert>
        )}
        {error && (
          <Alert tone="danger" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}
        {!data ? (
          !error && (
            <TableCard>
              <Table caption="Metrics (loading)">
                {head}
                <TBody>
                  <TableSkeletonRows rows={5} cols={5} />
                </TBody>
              </Table>
            </TableCard>
          )
        ) : data.metrics.length === 0 ? (
          <EmptyState
            icon={BarChart3}
            title="No metrics yet"
            description="Record results here (or from experiments). Matching metrics are injected into answers as verified structured data."
          />
        ) : (
          <TableCard>
            <Table caption="Metrics">
              {head}
              <TBody>
                {data.metrics.map((m) => (
                  <Tr key={m.id}>
                    <Td>
                      <div className="font-medium text-foreground">{m.label ?? m.metric_key}</div>
                      <div className="font-mono text-xs text-muted-foreground">{m.metric_key}</div>
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-muted-foreground">
                      {fmtDay(m.period_start)}
                      {m.period_end ? ` → ${fmtDay(m.period_end)}` : ""}
                    </Td>
                    <Td numeric>
                      <span className="font-semibold text-foreground">{fmtNumber(m.value)}</span>
                      {m.unit && <span className="ml-1 text-xs text-muted-foreground">{m.unit}</span>}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(m.dimensions ?? {}).map(([k, v]) => (
                          <Badge key={k} tone="neutral">
                            {k}={String(v)}
                          </Badge>
                        ))}
                      </div>
                    </Td>
                    <Td className="text-xs text-muted-foreground">
                      {humanize(m.source)}
                      {m.note && <div>{m.note}</div>}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableCard>
        )}
      </div>
      <SectionCard
        className="self-start"
        title="Record a result"
        description="Link it to an experiment or result object by ref to close the learning loop."
      >
        <div className="space-y-3">
          <Field label="Metric key" hint="snake_case, reused across periods.">
            <Input id="metric-key" value={f.metricKey} onChange={(e) => s("metricKey", e.target.value)} placeholder="close_rate" list="metric-keys" className="font-mono" />
          </Field>
          <datalist id="metric-keys">
            {(data?.keys ?? []).map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
          <Field label="Label">
            <Input value={f.label} onChange={(e) => s("label", e.target.value)} placeholder="NEMT close rate" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Value">
              <Input type="number" step="any" inputMode="decimal" value={f.value} onChange={(e) => s("value", e.target.value)} />
            </Field>
            <Field label="Unit">
              <Input value={f.unit} onChange={(e) => s("unit", e.target.value)} placeholder="%" />
            </Field>
            <Field label="Period start">
              <Input type="date" value={f.periodStart} onChange={(e) => s("periodStart", e.target.value)} />
            </Field>
            <Field label="Period end">
              <Input type="date" value={f.periodEnd} onChange={(e) => s("periodEnd", e.target.value)} />
            </Field>
          </div>
          <Field label="Dimensions" hint="key=value, separated by commas">
            <Input value={f.dimensions} onChange={(e) => s("dimensions", e.target.value)} placeholder="campaign=home_health, platform=linkedin" />
          </Field>
          <Field label="Linked object ref" hint="Optional, e.g. an experiment's ref.">
            <Input value={f.objectRef} onChange={(e) => s("objectRef", e.target.value.toUpperCase())} placeholder="EXP-014" className="font-mono" />
          </Field>
          <Field label="Note">
            <Input value={f.note} onChange={(e) => s("note", e.target.value)} />
          </Field>
          <Button disabled={!f.metricKey || f.value === "" || busy} loading={busy} onClick={add}>
            {!busy && <Plus size={16} aria-hidden />}
            Add metric
          </Button>
          <p className="text-xs text-muted-foreground">
            To attach results to experiments, use the{" "}
            <Link href="/dashboard/learning" className={LINK}>
              Learning Lab
            </Link>
            .
          </p>
        </div>
      </SectionCard>
      {dialog}
    </div>
  );
}
