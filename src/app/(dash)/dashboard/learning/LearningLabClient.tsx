"use client";

import * as React from "react";
import Link from "next/link";
import { Plus, Check, X, Award, Lightbulb, Link2, Calculator, Sparkles } from "lucide-react";
import { LEARNING_RECORD_TYPES, LEARNING_STATUSES, humanize } from "@/lib/intelligence-taxonomy";
import {
  Alert,
  Badge,
  Button,
  CompactStat,
  Dialog,
  EmptyState,
  Field,
  FilterTabs,
  IconButton,
  InlineError,
  Input,
  SectionCard,
  Select,
  Table,
  TableCard,
  TableSkeletonRows,
  TBody,
  Td,
  Textarea,
  Th,
  THead,
  Tr,
  useConfirm,
} from "@/components/ui";
import { api } from "@/components/ui/brain-ui";
import { fmtDate, relTime } from "@/lib/format";
import { statusTone } from "@/lib/ui-labels";

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
/** New evidence the Brain thinks belongs to an open record (a suggested `evidence_for` edge). */
interface Followup {
  edgeId: string;
  confidence: number | null;
  reason: string | null;
  createdAt: string;
  evidence: { id: string; ref: string; name: string; summary: string | null; domain: string; documentId: string | null };
  record: { id: string; objectId: string; ref: string; name: string; recordType: string; lifecycleStatus: string; department: string | null };
}
interface Resp {
  items: Item[];
  counts: { byType: Record<string, number>; byStatus: Record<string, number> };
  suggestedEdges: { source_object_id: string; target_object_id: string; relationship_type: string }[];
  followups?: Followup[];
  error?: string;
  migrationMissing?: boolean;
}
type FollowupAction = "attach_evidence" | "compute_result" | "ignore";

const TYPE_ORDER = ["experiment", "implementation", "decision", "result", "learning", "adaptation", "postmortem", "standard"];
const COLS = 8;
const REF_LINK = "rounded-md font-mono text-accent-strong underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Per-row feedback for the auto-saving status select. */
type RowSave = { id: string; state: "saving" | "saved" | "error" };

export function LearningLabClient() {
  const [data, setData] = React.useState<Resp | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [type, setType] = React.useState<string>("all");
  const [status, setStatus] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [recording, setRecording] = React.useState(false);
  const [computing, setComputing] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [rowSave, setRowSave] = React.useState<RowSave | null>(null);
  const savedTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const { confirm, dialog } = useConfirm();

  React.useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

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

  /** Same PATCH as before; resolves true when it went through (for the row's Saving…/Saved line). */
  async function patch(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    try {
      await api("/api/admin/knowledge/learning", { method: "PATCH", body: JSON.stringify(body) });
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(id: string, lifecycleStatus: string) {
    if (savedTimer.current) clearTimeout(savedTimer.current);
    setRowSave({ id, state: "saving" });
    const ok = await patch({ id, lifecycleStatus });
    setRowSave({ id, state: ok ? "saved" : "error" });
    if (ok) savedTimer.current = setTimeout(() => setRowSave((r) => (r?.id === id && r.state === "saved" ? null : r)), 1800);
  }

  async function promote(r: Item["record"]) {
    const ok = await confirm({
      title: "Promote to PractiScale Standard?",
      description: `Promote ${r.related_playbook_refs.join(", ") || "the related playbooks"} to PractiScale Standard based on this ${r.record_type}?`,
      confirmLabel: "Promote",
    });
    if (ok) void patch({ id: r.id, action: "promote_standard" });
  }

  async function followup(action: FollowupAction, f: Followup) {
    setBusy(true);
    if (action === "compute_result") setComputing(f.edgeId);
    setNotice(null);
    try {
      const r = await api<{ result?: { ref: string }; computed?: { via: "llm" | "fallback"; confidence: string } }>("/api/admin/knowledge/learning", {
        method: "POST",
        body: JSON.stringify({ action, edgeId: f.edgeId }),
      });
      if (action === "attach_evidence") setNotice(`${f.evidence.ref} attached as evidence to ${f.record.ref}.`);
      if (action === "compute_result" && r.result) {
        setNotice(
          r.computed?.via === "fallback"
            ? `${r.result.ref} proposed from ${f.evidence.ref} without a model — fill in the numbers, then validate.`
            : `${r.result.ref} proposed from ${f.evidence.ref} (confidence ${r.computed?.confidence ?? "low"}) — review and validate.`
        );
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
      setComputing(null);
    }
  }

  const counts = data?.counts.byType ?? {};
  const openDecisions = data?.items.filter((i) => i.record.record_type === "decision" && ["open", "proposed", "implementing"].includes(i.record.lifecycle_status)).length ?? 0;
  const followups = data?.followups ?? [];
  const statusOptions = LEARNING_STATUSES.map((s) => ({ value: s.id, label: s.label }));

  return (
    <div className="space-y-4">
      {followups.length > 0 && (
        <SectionCard
          icon={Sparkles}
          title="The Brain found evidence that may relate to an open experiment"
          description="New Business Reality that looks like it belongs to a decision, implementation or experiment you are still following. Nothing is linked until you confirm."
        >
          <ul className="space-y-2">
            {followups.map((f) => (
              <li key={f.edgeId} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface-muted/50 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <Link href={`/dashboard/knowledge/${f.evidence.id}`} className={REF_LINK}>{f.evidence.ref}</Link>
                    <span className="font-medium text-foreground">{f.evidence.name}</span>
                    <span className="text-muted-foreground">→ may be evidence for</span>
                    <Link href={`/dashboard/knowledge/${f.record.objectId}`} className={REF_LINK}>{f.record.ref}</Link>
                    <span className="font-medium text-foreground">{f.record.name}</span>
                    <Badge tone="neutral">{humanize(f.record.recordType)}</Badge>
                    <Badge tone={statusTone(f.record.lifecycleStatus)}>{humanize(f.record.lifecycleStatus)}</Badge>
                    {f.confidence != null && <Badge tone="neutral" title="Match score">{Math.round(f.confidence * 100)}%</Badge>}
                  </div>
                  {f.evidence.summary && <div className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{f.evidence.summary}</div>}
                  {f.reason && <div className="text-xs text-muted-foreground">{f.reason}</div>}
                </div>
                <div className="flex min-w-0 flex-wrap gap-1">
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => followup("attach_evidence", f)} title="Confirm the link and add this document to the record's evidence"><Link2 size={12} aria-hidden /> Attach evidence</Button>
                  <Button size="sm" disabled={busy} loading={computing === f.edgeId} onClick={() => followup("compute_result", f)} title="Attach the evidence and propose a Result record from it (you validate it)">{computing !== f.edgeId && <Calculator size={12} aria-hidden />} Compute result</Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => followup("ignore", f)} title="Not related"><X size={12} aria-hidden /> Ignore</Button>
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
      {notice && <Alert tone="success" role="status" onDismiss={() => setNotice(null)}>{notice}</Alert>}
      {/* One polite announcement for the auto-saving status selects (the row shows the same text). */}
      <div aria-live="polite" className="sr-only">
        {rowSave?.state === "saving" ? "Saving the status…" : rowSave?.state === "saved" ? "Status saved" : ""}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
        <CompactStat label="Experiments" value={counts.experiment ?? 0} />
        <CompactStat label="Implementations" value={counts.implementation ?? 0} />
        <CompactStat label="Open decisions" value={openDecisions} />
        <CompactStat label="Results" value={counts.result ?? 0} />
        <CompactStat label="Learnings" value={counts.learning ?? 0} />
        <CompactStat label="Adaptations" value={counts.adaptation ?? 0} />
        <CompactStat label="Postmortems" value={counts.postmortem ?? 0} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <FilterTabs
          label="Record filter"
          value={type}
          onChange={setType}
          tabs={[{ id: "all", label: "All" }, ...TYPE_ORDER.map((t) => ({ id: t, label: humanize(t), count: counts[t] ?? 0 }))]}
        />
        <Select
          density="compact"
          aria-label="Filter by status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          placeholder="Any status"
          className="w-44"
          options={statusOptions}
        />
        <div className="ml-auto">
          <Button size="toolbar" onClick={() => setRecording(true)}><Plus size={14} aria-hidden /> Record learning / experiment</Button>
        </div>
      </div>

      {data?.migrationMissing && (
        <Alert tone="info" title="Not enabled yet">
          <p>The Learning Lab isn&apos;t switched on in this workspace yet.</p>
          <details className="mt-1">
            <summary className="cursor-pointer text-xs font-medium text-foreground">Technical details</summary>
            <p className="mt-1 text-xs">
              Apply Brain migration <code className="font-mono">0017_operating_intelligence.sql</code> to enable the
              Learning Lab.
            </p>
          </details>
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}

      {data && data.items.length === 0 ? (
        <EmptyState
          icon={Lightbulb}
          title="No organizational learning recorded yet"
          description={'The Brain proposes learnings during chat ("Save as Organizational Learning?"). You can also record a decision, experiment or result here.'}
          action={<Button size="toolbar" onClick={() => setRecording(true)}><Plus size={14} aria-hidden /> Record one</Button>}
        />
      ) : (
        <TableCard>
          <Table minWidth={960} caption="Learning records" aria-busy={!data || undefined}>
            <THead>
              <tr>
                <Th>Ref</Th>
                <Th>Learning</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th>Dept · owner</Th>
                <Th>Playbooks</Th>
                <Th>Evidence</Th>
                <Th>Actions</Th>
              </tr>
            </THead>
            <TBody>
              {!data ? (
                <TableSkeletonRows cols={COLS} />
              ) : (
                data.items.map(({ record: r, object: o }) => {
                  const name = o?.name ?? o?.ref ?? "this record";
                  const save = rowSave?.id === r.id ? rowSave.state : null;
                  return (
                    <Tr key={r.id} interactive>
                      <Td className="whitespace-nowrap align-top font-mono text-xs">{o ? <Link href={`/dashboard/knowledge/${o.id}`} className={REF_LINK}>{o.ref}</Link> : "—"}</Td>
                      <Td className="align-top">
                        <div className="font-medium text-foreground">{o?.name ?? "(object missing)"}</div>
                        {o?.summary && <div className="line-clamp-1 text-xs text-muted-foreground">{o.summary}</div>}
                        {r.missing_evidence.length > 0 && (
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            <span className="font-medium text-warning">Missing:</span> {r.missing_evidence.slice(0, 3).join(" · ")}{r.missing_evidence.length > 3 ? "…" : ""}
                          </div>
                        )}
                      </Td>
                      <Td className="align-top"><Badge tone="neutral">{humanize(r.record_type)}</Badge></Td>
                      <Td className="align-top">
                        <Select
                          density="compact"
                          aria-label={`Status of ${name}`}
                          value={r.lifecycle_status}
                          onChange={(e) => void changeStatus(r.id, e.target.value)}
                          className="w-36"
                          options={statusOptions}
                          disabled={busy}
                        />
                        {(save === "saving" || save === "saved") && (
                          <div aria-hidden className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                            {save === "saved" && <Check size={12} className="text-success" />}
                            {save === "saving" ? "Saving…" : "Saved"}
                          </div>
                        )}
                        {save === "error" && <InlineError message="Couldn't save the status." className="mt-0.5" />}
                      </Td>
                      <Td className="align-top text-xs text-muted-foreground">{[r.department, r.owner].filter(Boolean).join(" · ") || "—"}</Td>
                      <Td className="align-top"><div className="flex flex-wrap gap-1">{r.related_playbook_refs.map((p) => <Badge key={p} tone="neutral" className="font-mono">{p}</Badge>)}</div></Td>
                      <Td className="align-top text-xs">
                        <span className="text-muted-foreground">{r.evidence_document_ids.length} doc{r.evidence_document_ids.length === 1 ? "" : "s"}</span>
                        {r.confidence && <Badge tone="neutral" className="ml-1">{r.confidence}</Badge>}
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {humanize(r.source)} · <time dateTime={r.updated_at} title={fmtDate(r.updated_at)}>{relTime(r.updated_at)}</time>
                        </div>
                      </Td>
                      <Td className="align-top">
                        <div className="flex flex-wrap items-center gap-1">
                          {r.lifecycle_status !== "validated" && <Button size="sm" variant="secondary" disabled={busy} onClick={() => patch({ id: r.id, action: "validate" })} title="Mark validated"><Check size={12} aria-hidden /> Validate</Button>}
                          {r.lifecycle_status !== "rejected" && (
                            <IconButton size="sm" aria-label={`Reject ${name}`} title="Reject" disabled={busy} onClick={() => patch({ id: r.id, action: "reject" })}>
                              <X size={14} aria-hidden />
                            </IconButton>
                          )}
                          {["learning", "adaptation", "result"].includes(r.record_type) && (
                            <Button size="sm" variant="secondary" disabled={busy} title="Promote the playbooks it used to PractiScale Standard" onClick={() => void promote(r)}>
                              <Award size={12} aria-hidden /> Promote
                            </Button>
                          )}
                        </div>
                      </Td>
                    </Tr>
                  );
                })
              )}
            </TBody>
          </Table>
        </TableCard>
      )}

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Lightbulb size={12} aria-hidden className="shrink-0" /> Promoting to PractiScale Standard marks the related playbooks validated + implemented (authority B1) and links them to this record.
      </p>

      {recording && <RecordModal onClose={() => setRecording(false)} onSaved={() => { setRecording(false); void load(); }} />}
      {dialog}
    </div>
  );
}

const EMPTY_RECORD = { kind: "learning", title: "", change: "", observedResult: "", department: "", owner: "", relatedRefs: "", missingEvidence: "", notes: "", confidence: "" };

function RecordModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = React.useState(EMPTY_RECORD);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const s = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const dirty = (Object.keys(EMPTY_RECORD) as (keyof typeof EMPTY_RECORD)[]).some((k) => f[k] !== EMPTY_RECORD[k]);

  // Escape, the X and Cancel never silently drop what was typed.
  async function requestClose() {
    if (dirty && !(await confirm({ title: "Discard this record?", description: "What you typed will be lost.", confirmLabel: "Discard", tone: "danger" }))) return;
    onClose();
  }

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
    <>
      <Dialog
        open
        onClose={() => void requestClose()}
        size="lg"
        closeOnBackdrop={false}
        dismissible={!busy}
        title="Record a learning"
        description="Concrete only: a specific change, where it happened and (ideally) an observed outcome. Generic opinions are not institutional learning."
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => void requestClose()}>Cancel</Button>
            <Button loading={busy} disabled={busy || (!f.title && !f.change)} onClick={save}>{!busy && <Check size={14} aria-hidden />} Save</Button>
          </>
        }
      >
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Kind"><Select value={f.kind} onChange={(e) => s("kind", e.target.value)} options={LEARNING_RECORD_TYPES.map((t) => ({ value: t, label: humanize(t) }))} /></Field>
          <Field label="Title"><Input value={f.title} onChange={(e) => s("title", e.target.value)} placeholder="Manager workload redesign" /></Field>
          <Field label="What we changed / decided" className="md:col-span-2"><Textarea rows={3} value={f.change} onChange={(e) => s("change", e.target.value)} placeholder="Daily recurring tasks → 175 min; alternate-day → 60 min; weekly → 0" /></Field>
          <Field label="Observed result" className="md:col-span-2"><Textarea rows={2} value={f.observedResult} onChange={(e) => s("observedResult", e.target.value)} placeholder="Manager involvement 63% → 31%; team output +18%; errors +7%" /></Field>
          <Field label="Department / team"><Input value={f.department} onChange={(e) => s("department", e.target.value)} placeholder="CRM" /></Field>
          <Field label="Owner"><Input value={f.owner} onChange={(e) => s("owner", e.target.value)} /></Field>
          <Field label="Playbooks used (refs, comma separated)"><Input value={f.relatedRefs} onChange={(e) => s("relatedRefs", e.target.value)} placeholder="MG-001, MG-002" /></Field>
          <Field label="Confidence"><Select value={f.confidence} onChange={(e) => s("confidence", e.target.value)} placeholder="—" options={["low", "medium", "high"].map((c) => ({ value: c, label: humanize(c) }))} /></Field>
          <Field label="Missing evidence (comma separated)" className="md:col-span-2"><Input value={f.missingEvidence} onChange={(e) => s("missingEvidence", e.target.value)} placeholder="baseline show-up rate, date range" /></Field>
          <Field label="Notes" className="md:col-span-2"><Textarea rows={3} value={f.notes} onChange={(e) => s("notes", e.target.value)} /></Field>
        </div>
        {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
      </Dialog>
      {dialog}
    </>
  );
}
