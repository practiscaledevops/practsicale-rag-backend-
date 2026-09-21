"use client";

import * as React from "react";
import Link from "next/link";
import { Plus, RefreshCw, Headphones } from "lucide-react";
import { C, Chip, KBtn, KInput, KSelect, KTable, Th, Td, Field, Panel, Empty, Spinner, ErrorNote, api } from "@/components/ui/brain-ui";

interface Metric { id: string; metric_key: string; label: string | null; value: number; unit: string | null; period_start: string | null; period_end: string | null; dimensions: Record<string, unknown>; source: string; object_id: string | null; note: string | null; created_at: string }

export function PerformanceClient() {
  const [data, setData] = React.useState<{ metrics: Metric[]; keys: string[]; migrationMissing?: boolean } | null>(null);
  const [key, setKey] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [f, setF] = React.useState({ metricKey: "", label: "", value: "", unit: "%", periodStart: "", periodEnd: "", dimensions: "", objectRef: "", note: "" });
  const s = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const [rebuilding, setRebuilding] = React.useState(false);
  const [rebuiltMsg, setRebuiltMsg] = React.useState<string | null>(null);

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

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-3 lg:col-span-2">
        <Panel padded={false}>
          <div className="flex flex-wrap items-center gap-3 p-3">
            <Headphones size={16} style={{ color: C.green }} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium" style={{ color: C.text }}>Performance from call scores</p>
              <p className="text-xs" style={{ color: C.muted }}>Turn the scored-call data into consultant entities + company / consultant / segment metrics + a cite-able snapshot object. Runs automatically after each call-scoring sync.</p>
            </div>
            <KBtn variant="primary" loading={rebuilding} onClick={rebuildFromCalls}><RefreshCw size={13} /> Rebuild from call scores</KBtn>
          </div>
          {rebuiltMsg && <p className="px-3 pb-3 text-xs" style={{ color: C.green }}>{rebuiltMsg}</p>}
        </Panel>
        <div className="flex gap-2">
          <KSelect value={key} onChange={(e) => setKey(e.target.value)} placeholder="All metrics" className="w-56" options={(data?.keys ?? []).map((k) => ({ value: k, label: k }))} />
        </div>
        {data?.migrationMissing && <ErrorNote message="Apply Brain migration 0017_operating_intelligence.sql to enable Performance Memory." />}
        <ErrorNote message={error} />
        {!data ? <Spinner /> : data.metrics.length === 0 ? (
          <Empty title="No metrics yet" hint="Record results here (or from experiments). Matching metrics are injected into answers as verified structured data." />
        ) : (
          <KTable head={<><Th>Metric</Th><Th>Period</Th><Th>Value</Th><Th>Dimensions</Th><Th>Source</Th></>}>
            {data.metrics.map((m) => (
              <tr key={m.id} className="hover:bg-white/[0.03]">
                <Td><div className="font-medium" style={{ color: C.text }}>{m.label ?? m.metric_key}</div><div className="font-mono text-[11px]" style={{ color: C.muted }}>{m.metric_key}</div></Td>
                <Td className="whitespace-nowrap text-xs"><span style={{ color: C.muted }}>{m.period_start ?? "—"}{m.period_end ? ` → ${m.period_end}` : ""}</span></Td>
                <Td><span className="font-semibold" style={{ color: C.green }}>{Number(m.value).toLocaleString()}</span>{m.unit && <span className="ml-1 text-xs" style={{ color: C.muted }}>{m.unit}</span>}</Td>
                <Td><div className="flex flex-wrap gap-1">{Object.entries(m.dimensions ?? {}).map(([k, v]) => <Chip key={k} tone="muted">{k}={String(v)}</Chip>)}</div></Td>
                <Td className="text-xs"><span style={{ color: C.muted }}>{m.source}</span>{m.note && <div style={{ color: C.muted }}>{m.note}</div>}</Td>
              </tr>
            ))}
          </KTable>
        )}
      </div>
      <Panel title="Record a result" subtitle="Link it to an experiment/result object by ref to close the learning loop.">
        <div className="space-y-3">
          <Field label="Metric key" hint="snake_case, reused across periods"><KInput value={f.metricKey} onChange={(e) => s("metricKey", e.target.value)} placeholder="close_rate" list="metric-keys" /><datalist id="metric-keys">{(data?.keys ?? []).map((k) => <option key={k} value={k} />)}</datalist></Field>
          <Field label="Label"><KInput value={f.label} onChange={(e) => s("label", e.target.value)} placeholder="NEMT close rate" /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Value"><KInput type="number" step="any" value={f.value} onChange={(e) => s("value", e.target.value)} /></Field>
            <Field label="Unit"><KInput value={f.unit} onChange={(e) => s("unit", e.target.value)} placeholder="%" /></Field>
            <Field label="Period start"><KInput type="date" value={f.periodStart} onChange={(e) => s("periodStart", e.target.value)} /></Field>
            <Field label="Period end"><KInput type="date" value={f.periodEnd} onChange={(e) => s("periodEnd", e.target.value)} /></Field>
          </div>
          <Field label="Dimensions" hint="k=v, k=v"><KInput value={f.dimensions} onChange={(e) => s("dimensions", e.target.value)} placeholder="campaign=home_health, platform=linkedin" /></Field>
          <Field label="Linked object ref"><KInput value={f.objectRef} onChange={(e) => s("objectRef", e.target.value.toUpperCase())} placeholder="EXP-014" /></Field>
          <Field label="Note"><KInput value={f.note} onChange={(e) => s("note", e.target.value)} /></Field>
          <KBtn variant="primary" disabled={!f.metricKey || f.value === "" || busy} loading={busy} onClick={add}><Plus size={13} /> Add metric</KBtn>
          <p className="text-[11px]" style={{ color: C.muted }}>Or see <Link href="/dashboard/learning" style={{ color: C.green }}>Learning Lab</Link> to attach results to experiments.</p>
        </div>
      </Panel>
    </div>
  );
}
