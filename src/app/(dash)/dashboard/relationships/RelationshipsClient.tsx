"use client";

import * as React from "react";
import Link from "next/link";
import { Check, X, Link2 } from "lucide-react";
import { RELATIONSHIP_TYPES, relationshipLabel } from "@/lib/intelligence-taxonomy";
import { C, Chip, KBtn, KInput, KSelect, KTabs, KTable, Th, Td, Field, Panel, Empty, Spinner, ErrorNote, api, classTone, CLASS_LABEL } from "@/components/ui/brain-ui";

interface Edge {
  id: string;
  source_object_id: string;
  relationship_type: string;
  target_object_id: string;
  status: string;
  confidence: number | null;
  origin: string;
  note: string | null;
  created_at: string;
}
interface Stub { id: string; ref: string; name: string; intelligence_class: string }
interface Resp { edges: Edge[]; objects: Record<string, Stub>; counts: Record<string, number>; error?: string; migrationMissing?: boolean }

export function RelationshipsClient() {
  const [status, setStatus] = React.useState<"suggested" | "confirmed" | "rejected">("suggested");
  const [data, setData] = React.useState<Resp | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [form, setForm] = React.useState({ sourceRef: "", type: "related_to", targetRef: "", note: "" });

  const load = React.useCallback(async () => {
    try {
      const d = await api<Resp>(`/api/admin/knowledge/relationships?status=${status}`);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [status]);
  React.useEffect(() => { void load(); }, [load]);

  async function act(body: Record<string, unknown>, method: "PATCH" | "POST") {
    setBusy(true);
    try {
      await api("/api/admin/knowledge/relationships", { method, body: JSON.stringify(body) });
      await load();
      if (method === "POST") setForm({ ...form, sourceRef: "", targetRef: "", note: "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const counts = data?.counts ?? {};
  const O = (id: string): Stub | undefined => data?.objects[id];

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-3 lg:col-span-2">
        <KTabs value={status} onChange={setStatus} tabs={[{ id: "suggested", label: "Suggested", count: counts.suggested }, { id: "confirmed", label: "Confirmed", count: counts.confirmed }, { id: "rejected", label: "Rejected", count: counts.rejected }]} />
        {data?.migrationMissing && <ErrorNote message="Apply Brain migration 0017_operating_intelligence.sql to enable relationships." />}
        <ErrorNote message={error} />
        {!data ? <Spinner /> : data.edges.length === 0 ? (
          <Empty title={status === "suggested" ? "No suggestions waiting" : `No ${status} relationships`} hint="The compiler suggests links when a new object is semantically close to an existing one; enrichment, conflict and learning links are created automatically." />
        ) : (
          <KTable
            head={<><Th>Source</Th><Th>Relationship</Th><Th>Target</Th><Th>Origin</Th><Th>Actions</Th></>}
          >
            {data.edges.map((e) => {
              const s = O(e.source_object_id);
              const t = O(e.target_object_id);
              return (
                <tr key={e.id} className="hover:bg-white/[0.03]">
                  <Td>{s ? <><Link href={`/dashboard/knowledge/${s.id}`} className="font-mono text-xs" style={{ color: C.green }}>{s.ref}</Link> <span style={{ color: C.text }}>{s.name}</span> <Chip tone={classTone(s.intelligence_class)}>{CLASS_LABEL[s.intelligence_class]}</Chip></> : <span style={{ color: C.muted }}>?</span>}</Td>
                  <Td>
                    {status === "suggested" ? (
                      <KSelect value={e.relationship_type} onChange={(ev) => act({ id: e.id, action: "confirm", type: ev.target.value }, "PATCH")} className="h-7 w-44 text-xs" disabled={busy} options={RELATIONSHIP_TYPES.map((r) => ({ value: r.id, label: r.label }))} />
                    ) : (
                      <span className="text-sm" style={{ color: C.text }}>{relationshipLabel(e.relationship_type)}</span>
                    )}
                    {e.note && <div className="text-[11px]" style={{ color: C.muted }}>{e.note}</div>}
                  </Td>
                  <Td>{t ? <><Link href={`/dashboard/knowledge/${t.id}`} className="font-mono text-xs" style={{ color: C.green }}>{t.ref}</Link> <span style={{ color: C.text }}>{t.name}</span></> : <span style={{ color: C.muted }}>?</span>}</Td>
                  <Td><Chip tone={e.origin === "ai" ? "amber" : e.origin === "system" ? "info" : "muted"}>{e.origin}</Chip>{typeof e.confidence === "number" && <span className="ml-1 text-xs" style={{ color: C.muted }}>{Math.round(e.confidence * 100)}%</span>}</Td>
                  <Td>
                    <div className="flex gap-1">
                      {status !== "confirmed" && <KBtn size="xs" variant="primary" disabled={busy} onClick={() => act({ id: e.id, action: "confirm" }, "PATCH")}><Check size={12} /> Confirm</KBtn>}
                      {status !== "rejected" && <KBtn size="xs" variant="ghost" disabled={busy} onClick={() => act({ id: e.id, action: "reject" }, "PATCH")}><X size={12} /></KBtn>}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </KTable>
        )}
      </div>
      <Panel title="Connect two objects" subtitle="By ref. Confirmed immediately (origin: user).">
        <div className="space-y-3">
          <Field label="Source ref"><KInput value={form.sourceRef} onChange={(e) => setForm({ ...form, sourceRef: e.target.value.toUpperCase() })} placeholder="MG-001" /></Field>
          <Field label="Relationship"><KSelect value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} options={RELATIONSHIP_TYPES.map((r) => ({ value: r.id, label: r.label }))} /></Field>
          <Field label="Target ref"><KInput value={form.targetRef} onChange={(e) => setForm({ ...form, targetRef: e.target.value.toUpperCase() })} placeholder="MG-002" /></Field>
          <Field label="Note"><KInput value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
          <KBtn variant="primary" disabled={!form.sourceRef || !form.targetRef || busy} onClick={() => act(form, "POST")}><Link2 size={13} /> Create edge</KBtn>
        </div>
      </Panel>
    </div>
  );
}
