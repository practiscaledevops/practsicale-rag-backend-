"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import { humanize } from "@/lib/intelligence-taxonomy";
import { C, Chip, KSelect, KTable, Th, Td, Empty, Spinner, ErrorNote, api } from "@/components/ui/brain-ui";

interface Decision { id: string; stage: string; decision: string; input: unknown; output: unknown; model: string | null; confidence: number | null; duration_ms: number | null; created_at: string; object_id: string | null }
interface Resp { decisions: Decision[]; objects: Record<string, { id: string; ref: string; name: string }>; counts: { byStage: Record<string, number>; byDecision: Record<string, number> }; migrationMissing?: boolean }

const STAGES = ["classify", "taxonomy", "dedup", "compile", "entities", "relationships", "learning", "guard", "persist"];

export function DecisionsClient() {
  const [stage, setStage] = React.useState("");
  const [decision, setDecision] = React.useState("");
  const [data, setData] = React.useState<Resp | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState<string | null>(null);

  React.useEffect(() => {
    (async () => {
      try {
        const p = new URLSearchParams();
        if (stage) p.set("stage", stage);
        if (decision) p.set("decision", decision);
        setData(await api<Resp>(`/api/admin/knowledge/decisions?${p}`));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      }
    })();
  }, [stage, decision]);

  const tone = (d: string) => (d.includes("new") ? "green" : d.includes("enrich") ? "info" : d.includes("duplicate") ? "amber" : d.includes("conflict") || d.includes("blocked") || d.includes("failed") ? "red" : d.includes("propose") || d.includes("suggest") ? "amber" : "muted");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <KSelect value={stage} onChange={(e) => setStage(e.target.value)} placeholder="All stages" className="w-44" options={STAGES.map((s) => ({ value: s, label: `${humanize(s)}${data?.counts.byStage[s] ? ` (${data.counts.byStage[s]})` : ""}` }))} />
        <KSelect value={decision} onChange={(e) => setDecision(e.target.value)} placeholder="All decisions" className="w-52" options={Object.keys(data?.counts.byDecision ?? {}).sort().map((d) => ({ value: d, label: `${humanize(d)} (${data!.counts.byDecision[d]})` }))} />
      </div>
      {data?.migrationMissing && <ErrorNote message="Apply Brain migration 0017_operating_intelligence.sql to start logging decisions." />}
      <ErrorNote message={error} />
      {!data ? <Spinner /> : data.decisions.length === 0 ? <Empty title="No decisions logged yet" hint="Compile something via Add knowledge and every decision will be recorded here." /> : (
        <KTable head={<><Th></Th><Th>When</Th><Th>Stage</Th><Th>Decision</Th><Th>Object</Th><Th>Model</Th><Th>Conf.</Th><Th>Time</Th></>}>
          {data.decisions.map((d) => {
            const o = d.object_id ? data.objects[d.object_id] : null;
            const isOpen = open === d.id;
            return (
              <React.Fragment key={d.id}>
                <tr className="cursor-pointer hover:bg-white/[0.03]" onClick={() => setOpen(isOpen ? null : d.id)}>
                  <Td className="w-6">{isOpen ? <ChevronDown size={14} style={{ color: C.muted }} /> : <ChevronRight size={14} style={{ color: C.muted }} />}</Td>
                  <Td className="whitespace-nowrap text-xs"><span style={{ color: C.muted }}>{new Date(d.created_at).toLocaleString()}</span></Td>
                  <Td><Chip tone="muted">{d.stage}</Chip></Td>
                  <Td><Chip tone={tone(d.decision)}>{humanize(d.decision)}</Chip></Td>
                  <Td>{o ? <Link href={`/dashboard/knowledge/${o.id}`} onClick={(e) => e.stopPropagation()}><span className="font-mono text-xs" style={{ color: C.green }}>{o.ref}</span> <span className="text-xs" style={{ color: C.text }}>{o.name}</span></Link> : <span style={{ color: C.muted }}>—</span>}</Td>
                  <Td className="text-xs"><span style={{ color: C.muted }}>{d.model ?? "—"}</span></Td>
                  <Td className="text-xs"><span style={{ color: C.muted }}>{typeof d.confidence === "number" ? `${Math.round(d.confidence * 100)}%` : "—"}</span></Td>
                  <Td className="text-xs"><span style={{ color: C.muted }}>{typeof d.duration_ms === "number" ? `${(d.duration_ms / 1000).toFixed(1)}s` : "—"}</span></Td>
                </tr>
                {isOpen && (
                  <tr>
                    <Td className="p-0" />
                    <td colSpan={7} className="px-3 pb-3" style={{ borderBottom: `1px solid ${C.border}` }}>
                      <div className="grid gap-2 md:grid-cols-2">
                        <pre className="max-h-64 overflow-auto rounded-lg p-2 text-[11px]" style={{ background: C.bg, color: C.muted, border: `1px solid ${C.border}` }}>input: {JSON.stringify(d.input, null, 2)}</pre>
                        <pre className="max-h-64 overflow-auto rounded-lg p-2 text-[11px]" style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}` }}>output: {JSON.stringify(d.output, null, 2)}</pre>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </KTable>
      )}
    </div>
  );
}
