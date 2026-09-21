"use client";

import * as React from "react";
import Link from "next/link";
import { Plus, Check, X, Award, Lightbulb } from "lucide-react";
import { LEARNING_RECORD_TYPES, LEARNING_STATUSES, humanize } from "@/lib/intelligence-taxonomy";
import { C, Chip, KBtn, KInput, KSelect, KTextarea, KTabs, KTable, Th, Td, Field, Panel, Empty, Spinner, ErrorNote, StatBox, fmtDate, api } from "@/components/ui/brain-ui";

interface Item {
  record: {
    id: string;
    object_id: string;
    record_type: string;
    lifecycle_status: string;
    department: string | null;
    owner: string | null;
    confidence: string | null;
    related_playbook_refs: string[];
    missing_evidence: string[];
    evidence_document_ids: string[];
    parent_record_id: string | null;
    source: string;
    updated_at: string;
  };
  object: { id: string; ref: string; name: string; summary: string | null; internal_validation: string; founder_endorsement: string | null } | null;
}
interface Resp {
  items: Item[];
  counts: { byType: Record<string, number>; byStatus: Record<string, number> };
  suggestedEdges: { source_object_id: string; target_object_id: string; relationship_type: string }[];
  error?: string;
  migrationMissing?: boolean;
}

const TYPE_ORDER = ["experiment", "implementation", "decision", "result", "learning", "adaptation", "postmortem", "standard"];

export function LearningLabClient() {
  const [data, setData] = React.useState<Resp | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [type, setType] = React.useState<string>("all");
  const [status, setStatus] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [recording, setRecording] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const p = new URLSearchParams();
      if (type !== "all") p.set("type", type);
      if (status) p.set("status", status);
      const d = await api<Resp>(`/api/admin/knowledge/learning?${p}`);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [type, status]);
  React.useEffect(() => { void load(); }, [load]);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    try {
      await api("/api/admin/knowledge/learning", { method: "PATCH", body: JSON.stringify(body) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  const counts = data?.counts.byType ?? {};
  const openDecisions = data?.items.filter((i) => i.record.record_type === "decision" && ["open", "proposed", "implementing"].includes(i.record.lifecycle_status)).length ?? 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <StatBox label="Experiments" value={counts.experiment ?? 0} />
        <StatBox label="Implementations" value={counts.implementation ?? 0} />
        <StatBox label="Open decisions" value={openDecisions} tone="amber" />
        <StatBox label="Results" value={counts.result ?? 0} tone="info" />
        <StatBox label="Learnings" value={counts.learning ?? 0} tone="violet" />
        <StatBox label="Adaptations" value={counts.adaptation ?? 0} tone="mint" />
        <StatBox label="Postmortems" value={counts.postmortem ?? 0} tone="muted" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <KTabs
          value={type}
          onChange={setType}
          tabs={[{ id: "all", label: "All" }, ...TYPE_ORDER.map((t) => ({ id: t, label: humanize(t), count: counts[t] ?? 0 }))]}
        />
        <KSelect value={status} onChange={(e) => setStatus(e.target.value)} placeholder="Any status" className="w-44" options={LEARNING_STATUSES.map((s) => ({ value: s.id, label: s.label }))} />
        <div className="ml-auto">
          <KBtn variant="primary" onClick={() => setRecording(true)}><Plus size={14} /> Record learning / experiment</KBtn>
        </div>
      </div>

      {data?.migrationMissing && <ErrorNote message="Apply Brain migration 0017_operating_intelligence.sql to enable the Learning Lab." />}
      <ErrorNote message={error} />

      {!data ? (
        <Spinner label="Loading learning records…" />
      ) : data.items.length === 0 ? (
        <Empty
          title="No organizational learning recorded yet"
          hint={'The Brain proposes learnings during chat ("Save as Organizational Learning?"). You can also record a decision, experiment or result here.'}
          action={<KBtn variant="primary" onClick={() => setRecording(true)}><Plus size={14} /> Record one</KBtn>}
        />
      ) : (
        <KTable
          head={
            <>
              <Th>Ref</Th>
              <Th>Learning</Th>
              <Th>Type</Th>
              <Th>Status</Th>
              <Th>Dept · Owner</Th>
              <Th>Playbooks</Th>
              <Th>Evidence</Th>
              <Th>Actions</Th>
            </>
          }
        >
          {data.items.map(({ record: r, object: o }) => (
            <tr key={r.id} className="hover:bg-white/[0.03]">
              <Td className="whitespace-nowrap font-mono text-xs">{o ? <Link href={`/dashboard/knowledge/${o.id}`} style={{ color: C.green }}>{o.ref}</Link> : "—"}</Td>
              <Td>
                <div className="font-medium" style={{ color: C.text }}>{o?.name ?? "(object missing)"}</div>
                {o?.summary && <div className="line-clamp-1 text-xs" style={{ color: C.muted }}>{o.summary}</div>}
                {r.missing_evidence.length > 0 && <div className="mt-0.5 text-[11px]" style={{ color: C.amber }}>Missing: {r.missing_evidence.slice(0, 3).join(" · ")}{r.missing_evidence.length > 3 ? "…" : ""}</div>}
              </Td>
              <Td><Chip tone="violet">{humanize(r.record_type)}</Chip></Td>
              <Td>
                <KSelect value={r.lifecycle_status} onChange={(e) => patch({ id: r.id, lifecycleStatus: e.target.value })} className="h-7 w-36 text-xs" options={LEARNING_STATUSES.map((s) => ({ value: s.id, label: s.label }))} disabled={busy} />
              </Td>
              <Td className="text-xs"><span style={{ color: C.muted }}>{[r.department, r.owner].filter(Boolean).join(" · ") || "—"}</span></Td>
              <Td><div className="flex flex-wrap gap-1">{r.related_playbook_refs.map((p) => <Chip key={p} tone="info">{p}</Chip>)}</div></Td>
              <Td className="text-xs">
                <span style={{ color: C.muted }}>{r.evidence_document_ids.length} doc{r.evidence_document_ids.length === 1 ? "" : "s"}</span>
                {r.confidence && <Chip tone="muted" className="ml-1">{r.confidence}</Chip>}
                <div className="text-[10px]" style={{ color: C.muted }}>{humanize(r.source)} · {fmtDate(r.updated_at)}</div>
              </Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {r.lifecycle_status !== "validated" && <KBtn size="xs" disabled={busy} onClick={() => patch({ id: r.id, action: "validate" })} title="Mark validated"><Check size={12} /> Validate</KBtn>}
                  {r.lifecycle_status !== "rejected" && <KBtn size="xs" variant="ghost" disabled={busy} onClick={() => patch({ id: r.id, action: "reject" })} title="Reject"><X size={12} /></KBtn>}
                  {["learning", "adaptation", "result"].includes(r.record_type) && (
                    <KBtn size="xs" variant="primary" disabled={busy} title="Promote the playbooks it used to PractiScale Standard" onClick={() => {
                      if (window.confirm(`Promote ${r.related_playbook_refs.join(", ") || "the related playbooks"} to PractiScale Standard based on this ${r.record_type}?`)) void patch({ id: r.id, action: "promote_standard" });
                    }}><Award size={12} /> Standard</KBtn>
                  )}
                </div>
              </Td>
            </tr>
          ))}
        </KTable>
      )}

      <p className="flex items-center gap-1 text-[11px]" style={{ color: C.muted }}>
        <Lightbulb size={11} /> Promoting to PractiScale Standard marks the related playbooks validated + implemented (authority B1) and links them to this record.
      </p>

      {recording && <RecordModal onClose={() => setRecording(false)} onSaved={() => { setRecording(false); void load(); }} />}
    </div>
  );
}

function RecordModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = React.useState({ kind: "learning", title: "", change: "", observedResult: "", department: "", owner: "", relatedRefs: "", missingEvidence: "", notes: "", confidence: "" });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const s = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/knowledge/learning", {
        method: "POST",
        body: JSON.stringify({
          ...f,
          relatedRefs: f.relatedRefs.split(",").map((x) => x.trim()).filter(Boolean),
          missingEvidence: f.missingEvidence.split(",").map((x) => x.trim()).filter(Boolean),
          confidence: f.confidence || undefined,
        }),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <Panel title="Record organizational learning" subtitle="Concrete only: a specific change + where + (ideally) an observed outcome. Generic opinions are not institutional learning." actions={<KBtn variant="ghost" onClick={onClose}><X size={14} /></KBtn>}>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Kind"><KSelect value={f.kind} onChange={(e) => s("kind", e.target.value)} options={LEARNING_RECORD_TYPES.map((t) => ({ value: t, label: humanize(t) }))} /></Field>
            <Field label="Title"><KInput value={f.title} onChange={(e) => s("title", e.target.value)} placeholder="Manager workload redesign" /></Field>
            <Field label="What we changed / decided" className="md:col-span-2"><KTextarea rows={3} value={f.change} onChange={(e) => s("change", e.target.value)} placeholder="Daily recurring tasks → 175 min; alternate-day → 60 min; weekly → 0" /></Field>
            <Field label="Observed result" className="md:col-span-2"><KTextarea rows={2} value={f.observedResult} onChange={(e) => s("observedResult", e.target.value)} placeholder="Manager involvement 63% → 31%; team output +18%; errors +7%" /></Field>
            <Field label="Department / team"><KInput value={f.department} onChange={(e) => s("department", e.target.value)} placeholder="CRM" /></Field>
            <Field label="Owner"><KInput value={f.owner} onChange={(e) => s("owner", e.target.value)} /></Field>
            <Field label="Playbooks used (refs, comma separated)"><KInput value={f.relatedRefs} onChange={(e) => s("relatedRefs", e.target.value)} placeholder="MG-001, MG-002" /></Field>
            <Field label="Confidence"><KSelect value={f.confidence} onChange={(e) => s("confidence", e.target.value)} placeholder="—" options={["low", "medium", "high"].map((c) => ({ value: c, label: humanize(c) }))} /></Field>
            <Field label="Missing evidence (comma separated)" className="md:col-span-2"><KInput value={f.missingEvidence} onChange={(e) => s("missingEvidence", e.target.value)} placeholder="baseline show-up rate, date range" /></Field>
            <Field label="Notes" className="md:col-span-2"><KTextarea rows={3} value={f.notes} onChange={(e) => s("notes", e.target.value)} /></Field>
          </div>
          <ErrorNote message={error} />
          <div className="mt-3 flex justify-end gap-2">
            <KBtn variant="ghost" onClick={onClose}>Cancel</KBtn>
            <KBtn variant="primary" loading={busy} disabled={busy || (!f.title && !f.change)} onClick={save}><Check size={14} /> Save</KBtn>
          </div>
        </Panel>
      </div>
    </div>
  );
}
