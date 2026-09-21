"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Save, Trash2, Check, X, Link2, RefreshCw } from "lucide-react";
import {
  DOMAINS,
  REALITY_BUCKETS,
  FOUNDER_ENDORSEMENTS,
  IMPLEMENTATION_STATUSES,
  INTERNAL_VALIDATIONS,
  EVIDENCE_LEVELS,
  PRIORITIES,
  OBJECT_STATUSES,
  AUTHORITY_LEVELS,
  RELATIONSHIP_TYPES,
  LEARNING_STATUSES,
  typesFor,
  domainLabel,
  typeLabel,
  relationshipLabel,
  authorityLabel,
  type IntelligenceClass,
} from "@/lib/intelligence-taxonomy";
import {
  C,
  Chip,
  KBtn,
  KInput,
  KSelect,
  KTextarea,
  KTabs,
  Field,
  Panel,
  Spinner,
  ErrorNote,
  Empty,
  fmtDate,
  humanize,
  endorsementTone,
  authorityTone,
  statusTone,
  classTone,
  CLASS_LABEL,
  api,
} from "@/components/ui/brain-ui";

interface Detail {
  object: Record<string, unknown> & {
    id: string;
    ref: string;
    name: string;
    intelligence_class: IntelligenceClass;
    domain: string;
    object_type: string;
    subtype: string | null;
    status: string;
    priority: string;
    founder_endorsement: string | null;
    implementation_status: string;
    internal_validation: string;
    evidence_level: string | null;
    authority: string;
    applies_to: string[];
    goals: string[];
    applies_to_platforms: string[];
    tags: string[];
    source_expert: string | null;
    source_type: string | null;
    source_platform: string | null;
    source_url: string | null;
    source_date: string | null;
    source_claims: { claim: string; kind?: string; verified?: boolean; tested?: boolean }[];
    sources: { expert?: string | null; type?: string | null; platform?: string | null; url?: string | null; date?: string | null; added_at?: string; note?: string | null }[];
    effective_from: string | null;
    effective_until: string | null;
    last_verified_at: string | null;
    version: number;
    summary: string | null;
    compiled_markdown: string | null;
    document_id: string | null;
    raw_document_id: string | null;
    created_by: string | null;
    created_at: string;
    updated_at: string;
    bucket: string | null;
  };
  sections: { heading: string; body: string }[];
  relationships: { id: string; relationship_type: string; status: string; confidence: number | null; origin: string; note: string | null; direction: "in" | "out"; other: { id: string; ref: string; name: string; intelligence_class: string } | null }[];
  entities: { id: string; role: string | null; value: string | null; entity: { id: string; kind: string; name: string; mention_count: number } | null }[];
  chunkCount: number;
  decisions: { id: string; stage: string; decision: string; model: string | null; confidence: number | null; duration_ms: number | null; created_at: string; output: unknown }[];
  learning: (Record<string, unknown> & { id: string; record_type: string; lifecycle_status: string; department: string | null; owner: string | null; related_playbook_refs: string[]; missing_evidence: string[]; confidence: string | null }) | null;
  learningChain: { id: string; record_type: string; lifecycle_status: string; object: { id: string; ref: string; name: string } | null }[];
  error?: string;
}

type Tab = "overview" | "governance" | "provenance" | "relationships" | "entities" | "learning" | "log" | "markdown";

export function ObjectDetailClient({ id }: { id: string }) {
  const router = useRouter();
  const [data, setData] = React.useState<Detail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<Tab>("overview");
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const d = await api<Detail>(`/api/admin/knowledge/objects/${id}`);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [id]);
  React.useEffect(() => { void load(); }, [load]);

  async function patch(body: Record<string, unknown>, okMsg = "Saved") {
    setBusy(true);
    setNotice(null);
    try {
      await api(`/api/admin/knowledge/objects/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      await load();
      setNotice(okMsg);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!data) return;
    if (!window.confirm(`Delete ${data.object.ref} "${data.object.name}"? Its chunks, relationships and mentions are removed too.`)) return;
    setBusy(true);
    try {
      await api(`/api/admin/knowledge/objects/${id}`, { method: "DELETE" });
      router.push("/dashboard/knowledge");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
      setBusy(false);
    }
  }

  if (error && !data) return <div className="space-y-3"><Link href="/dashboard/knowledge" className="text-xs" style={{ color: C.muted }}>← Knowledge objects</Link><ErrorNote message={error} /></div>;
  if (!data) return <Spinner label="Loading object…" />;
  const o = data.object;
  const expired = !!o.effective_until && new Date(o.effective_until).getTime() <= Date.now();
  const suggested = data.relationships.filter((r) => r.status === "suggested");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/dashboard/knowledge" className="inline-flex items-center gap-1 text-xs" style={{ color: C.muted }}><ArrowLeft size={12} /> Knowledge objects</Link>
          <h1 className="mt-1 flex flex-wrap items-center gap-2 text-xl font-semibold" style={{ color: C.text }}>
            <span className="font-mono text-base" style={{ color: C.green }}>{o.ref}</span> {o.name}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Chip tone={classTone(o.intelligence_class)}>{CLASS_LABEL[o.intelligence_class]}</Chip>
            <span className="text-xs" style={{ color: C.muted }}>{domainLabel(o.domain)} · {typeLabel(o.object_type)}{o.subtype ? ` · ${humanize(o.subtype)}` : ""}</span>
            {o.bucket && <Chip tone="muted">{REALITY_BUCKETS.find((b) => b.id === o.bucket)?.label}</Chip>}
            <Chip tone={statusTone(o.status)}>{humanize(o.status)}</Chip>
            {expired && <Chip tone="red">Expired</Chip>}
            <Chip tone={authorityTone(o.authority)} title={authorityLabel(o.authority)}>{o.authority}</Chip>
            {o.founder_endorsement && <Chip tone={endorsementTone(o.founder_endorsement)}>{humanize(o.founder_endorsement)}</Chip>}
            {o.internal_validation !== "unvalidated" && <Chip tone={o.internal_validation === "validated" ? "green" : o.internal_validation === "rejected" ? "red" : "amber"}>{humanize(o.internal_validation)}</Chip>}
            {o.priority === "core" && <Chip tone="amber">Core</Chip>}
            <span className="text-[11px]" style={{ color: C.muted }}>v{o.version} · {data.chunkCount} chunks · updated {fmtDate(o.updated_at)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {suggested.length > 0 && <Chip tone="amber">{suggested.length} suggested link{suggested.length > 1 ? "s" : ""}</Chip>}
          <KBtn variant="danger" onClick={remove} disabled={busy}><Trash2 size={13} /> Delete</KBtn>
        </div>
      </div>

      <KTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "governance", label: "Governance" },
          { id: "provenance", label: "Provenance", count: (o.sources ?? []).length },
          { id: "relationships", label: "Relationships", count: data.relationships.length },
          { id: "entities", label: "Entities", count: data.entities.length },
          ...(o.intelligence_class === "organizational_learning" ? [{ id: "learning" as Tab, label: "Learning lifecycle" }] : []),
          { id: "log", label: "Decision log", count: data.decisions.length },
          { id: "markdown", label: "Markdown" },
        ]}
      />
      {notice && <p className="text-xs" style={{ color: C.green }}>{notice}</p>}
      <ErrorNote message={error} />

      {tab === "overview" && (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            {o.summary && <Panel title="Summary"><p className="text-sm leading-relaxed" style={{ color: C.text }}>{o.summary}</p></Panel>}
            {data.sections.length === 0 ? (
              <Empty title="No compiled sections" hint="Edit the markdown to add sections." />
            ) : (
              data.sections.map((s) => (
                <Panel key={s.heading} title={s.heading}>
                  <div className="whitespace-pre-wrap text-sm leading-relaxed" style={{ color: C.text }}>{s.body}</div>
                </Panel>
              ))
            )}
          </div>
          <div className="space-y-4">
            <Panel title="Applies to & goals">
              <div className="space-y-2 text-xs">
                <Row label="Applies to">{o.applies_to.length ? o.applies_to.map((a) => <Chip key={a} tone="muted">{humanize(a)}</Chip>) : "—"}</Row>
                <Row label="Goals">{o.goals.length ? o.goals.map((a) => <Chip key={a} tone="muted">{humanize(a)}</Chip>) : "—"}</Row>
                <Row label="Platforms">{o.applies_to_platforms.length ? o.applies_to_platforms.map((a) => <Chip key={a} tone="mint">{humanize(a)}</Chip>) : "Universal"}</Row>
                <Row label="Tags">{o.tags.length ? o.tags.map((a) => <Chip key={a} tone="muted">{a}</Chip>) : "—"}</Row>
              </div>
            </Panel>
            <Panel title="Currency">
              <div className="space-y-1 text-xs" style={{ color: C.text }}>
                <Row label="Effective from">{fmtDate(o.effective_from)}</Row>
                <Row label="Effective until">{fmtDate(o.effective_until)}</Row>
                <Row label="Last verified">{fmtDate(o.last_verified_at)}</Row>
                <Row label="Created">{fmtDate(o.created_at)}{o.created_by ? ` by ${o.created_by}` : ""}</Row>
              </div>
              <KBtn size="xs" className="mt-2" onClick={() => patch({ verify_now: true }, "Marked as verified today")} disabled={busy}><Check size={12} /> Verified today</KBtn>
            </Panel>
            {data.relationships.length > 0 && (
              <Panel title="Connected knowledge">
                <ul className="space-y-1 text-xs">
                  {data.relationships.filter((r) => r.status === "confirmed").slice(0, 10).map((r) => (
                    <li key={r.id} style={{ color: C.text }}>
                      {r.direction === "out" ? relationshipLabel(r.relationship_type) : `← ${relationshipLabel(r.relationship_type)}`}{" "}
                      {r.other ? <Link href={`/dashboard/knowledge/${r.other.id}`} className="font-mono" style={{ color: C.green }}>{r.other.ref}</Link> : "?"} {r.other?.name}
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
          </div>
        </div>
      )}

      {tab === "governance" && <GovernanceEditor o={o} busy={busy} onSave={(body) => patch(body)} />}

      {tab === "provenance" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Primary source">
            <div className="space-y-1 text-sm" style={{ color: C.text }}>
              <Row label="Expert">{o.source_expert ?? "—"}</Row>
              <Row label="Type">{humanize(o.source_type) ?? "—"}</Row>
              <Row label="Found on">{humanize(o.source_platform)}</Row>
              <Row label="Date">{o.source_date ?? "—"}</Row>
              <Row label="URL">{o.source_url ? <a href={o.source_url} target="_blank" rel="noreferrer" style={{ color: C.green }}>{o.source_url}</a> : "—"}</Row>
              <Row label="Evidence level">{humanize(o.evidence_level)}</Row>
              <Row label="Raw source">{o.raw_document_id ? <Link href={`/dashboard/documents/${o.raw_document_id}`} style={{ color: C.green }}>stored separately (raw archive)</Link> : "not stored"}</Row>
              <Row label="Compiled document">{o.document_id ? <Link href={`/dashboard/documents/${o.document_id}`} style={{ color: C.green }}>open document</Link> : "—"}</Row>
            </div>
          </Panel>
          <Panel title={`All sources (${(o.sources ?? []).length})`} subtitle="Every source that fed this object — enrichments and duplicates add here.">
            {(o.sources ?? []).length === 0 ? <p className="text-xs" style={{ color: C.muted }}>—</p> : (
              <ul className="space-y-2 text-xs" style={{ color: C.text }}>
                {(o.sources ?? []).map((s, i) => (
                  <li key={i} className="rounded-lg p-2" style={{ border: `1px solid ${C.border}` }}>
                    {[s.expert, s.type, s.platform, s.date].filter(Boolean).map(String).map(humanize).join(" · ") || "unnamed source"}
                    {s.note && <Chip tone="muted" className="ml-2">{s.note}</Chip>}
                    {s.url && <div><a href={s.url} target="_blank" rel="noreferrer" style={{ color: C.green }}>{s.url}</a></div>}
                    {s.added_at && <div style={{ color: C.muted }}>added {fmtDate(s.added_at)}</div>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel className="lg:col-span-2" title="Source claims" subtitle="What the source claimed. Claims stay claims until PractiScale verifies or tests them.">
            {(o.source_claims ?? []).length === 0 ? <p className="text-xs" style={{ color: C.muted }}>No explicit claims recorded.</p> : (
              <ul className="space-y-1 text-sm" style={{ color: C.text }}>
                {o.source_claims.map((c, i) => (
                  <li key={i}>• {c.claim} <Chip tone={c.verified ? "green" : c.tested ? "mint" : "amber"}>{c.verified ? "verified" : c.tested ? "tested" : `${c.kind ?? "claim"}, unverified`}</Chip></li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}

      {tab === "relationships" && <RelationshipsTab data={data} busy={busy} setBusy={setBusy} reload={load} setError={setError} />}

      {tab === "entities" && (
        <Panel title="Entities mentioned" subtitle="WHO and WHAT exist inside this knowledge.">
          {data.entities.length === 0 ? <p className="text-xs" style={{ color: C.muted }}>No entities extracted.</p> : (
            <div className="flex flex-wrap gap-1.5">
              {data.entities.map((m) => m.entity && (
                <Link key={m.id} href={`/dashboard/entities?id=${m.entity.id}`}>
                  <Chip tone="muted" title={`${m.role ?? ""} ${m.value ?? ""}`.trim() || undefined}>{humanize(m.entity.kind)}: {m.entity.name}{m.role ? ` (${m.role})` : ""}</Chip>
                </Link>
              ))}
            </div>
          )}
        </Panel>
      )}

      {tab === "learning" && (
        <Panel title="Learning lifecycle" subtitle="decision → implementation → experiment → result → learning → adaptation → PractiScale standard">
          {!data.learning ? <p className="text-xs" style={{ color: C.muted }}>No lifecycle record.</p> : (
            <div className="space-y-3 text-sm" style={{ color: C.text }}>
              <div className="flex flex-wrap gap-1.5">
                <Chip tone="violet">{humanize(data.learning.record_type)}</Chip>
                <Chip tone={data.learning.lifecycle_status === "validated" ? "green" : data.learning.lifecycle_status === "rejected" ? "red" : "amber"}>{humanize(data.learning.lifecycle_status)}</Chip>
                {data.learning.department && <Chip tone="muted">{data.learning.department}</Chip>}
                {data.learning.confidence && <Chip tone="muted">confidence {data.learning.confidence}</Chip>}
              </div>
              {data.learning.related_playbook_refs.length > 0 && <Row label="Playbooks used">{data.learning.related_playbook_refs.map((r) => <Chip key={r} tone="info">{r}</Chip>)}</Row>}
              {data.learning.missing_evidence.length > 0 && (
                <div><p className="text-xs font-semibold" style={{ color: C.amber }}>Missing evidence</p><ul className="text-xs" style={{ color: C.text }}>{data.learning.missing_evidence.map((m, i) => <li key={i}>• {m}</li>)}</ul></div>
              )}
              {data.learningChain.length > 0 && (
                <div><p className="text-xs font-semibold" style={{ color: C.muted }}>Chain</p>
                  <ul className="text-xs">{data.learningChain.map((c) => <li key={c.id}>{humanize(c.record_type)} · {c.object ? <Link href={`/dashboard/knowledge/${c.object.id}`} className="font-mono" style={{ color: C.green }}>{c.object.ref}</Link> : "?"} {c.object?.name} <Chip tone="muted">{humanize(c.lifecycle_status)}</Chip></li>)}</ul>
                </div>
              )}
              <Link href="/dashboard/learning"><KBtn size="xs">Manage in the Learning Lab</KBtn></Link>
              <span className="ml-2 text-[11px]" style={{ color: C.muted }}>Statuses: {LEARNING_STATUSES.map((s) => s.label).join(" → ")}</span>
            </div>
          )}
        </Panel>
      )}

      {tab === "log" && (
        <Panel title="Decision log" subtitle="Every automatic classification, dedup, taxonomy and relationship decision, inspectable.">
          {data.decisions.length === 0 ? <p className="text-xs" style={{ color: C.muted }}>No decisions logged.</p> : (
            <ul className="space-y-1.5 text-xs">
              {data.decisions.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5" style={{ border: `1px solid ${C.border}`, color: C.text }}>
                  <Chip tone="muted">{d.stage}</Chip>
                  <span className="font-medium">{humanize(d.decision)}</span>
                  {d.model && <span style={{ color: C.muted }}>{d.model}</span>}
                  {typeof d.confidence === "number" && <span style={{ color: C.muted }}>{Math.round(d.confidence * 100)}%</span>}
                  {typeof d.duration_ms === "number" && <span style={{ color: C.muted }}>{(d.duration_ms / 1000).toFixed(1)}s</span>}
                  <span className="ml-auto" style={{ color: C.muted }}>{new Date(d.created_at).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {tab === "markdown" && <MarkdownEditor initial={o.compiled_markdown ?? ""} busy={busy} onSave={(md) => patch({ compiled_markdown: md }, "Markdown saved and re-chunked")} />}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-28 shrink-0 text-[11px] font-semibold uppercase tracking-wider" style={{ color: C.muted }}>{label}</span>
      <span className="flex flex-wrap items-center gap-1">{children}</span>
    </div>
  );
}

function GovernanceEditor({ o, busy, onSave }: { o: Detail["object"]; busy: boolean; onSave: (body: Record<string, unknown>) => void }) {
  const [f, setF] = React.useState({
    name: o.name,
    domain: o.domain,
    object_type: o.object_type,
    subtype: o.subtype ?? "",
    status: o.status,
    priority: o.priority,
    founder_endorsement: o.founder_endorsement ?? "",
    implementation_status: o.implementation_status,
    internal_validation: o.internal_validation,
    evidence_level: o.evidence_level ?? "",
    authority: o.authority,
    effective_from: o.effective_from?.slice(0, 10) ?? "",
    effective_until: o.effective_until?.slice(0, 10) ?? "",
    tags: o.tags.join(", "),
    applies_to: o.applies_to.join(", "),
    goals: o.goals.join(", "),
    summary: o.summary ?? "",
  });
  const s = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const types = typesFor(o.intelligence_class, f.domain);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Classification">
        <div className="space-y-3">
          <Field label="Name"><KInput value={f.name} onChange={(e) => s("name", e.target.value)} /></Field>
          <Field label="Summary"><KTextarea rows={3} value={f.summary} onChange={(e) => s("summary", e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Domain"><KSelect value={f.domain} onChange={(e) => s("domain", e.target.value)} options={DOMAINS.map((d) => ({ value: d.id, label: d.label }))} /></Field>
            <Field label="Type"><KSelect value={f.object_type} onChange={(e) => s("object_type", e.target.value)} options={types.map((t) => ({ value: t.id, label: t.label }))} /></Field>
          </div>
          <Field label="Subtype"><KInput value={f.subtype} onChange={(e) => s("subtype", e.target.value)} /></Field>
          <Field label="Applies to"><KInput value={f.applies_to} onChange={(e) => s("applies_to", e.target.value)} /></Field>
          <Field label="Goals"><KInput value={f.goals} onChange={(e) => s("goals", e.target.value)} /></Field>
          <Field label="Tags"><KInput value={f.tags} onChange={(e) => s("tags", e.target.value)} /></Field>
        </div>
      </Panel>
      <Panel title="Governance" subtitle="Do I believe in it? → Founder endorsement. Have we used it? → Implementation. Did it work? → Validation.">
        <div className="space-y-3">
          <Field label="Founder endorsement">
            <KSelect value={f.founder_endorsement} onChange={(e) => s("founder_endorsement", e.target.value)} placeholder="— none —" options={FOUNDER_ENDORSEMENTS.map((x) => ({ value: x.id, label: `${x.label} — ${x.hint}` }))} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Implementation"><KSelect value={f.implementation_status} onChange={(e) => s("implementation_status", e.target.value)} options={IMPLEMENTATION_STATUSES.map((x) => ({ value: x.id, label: x.label }))} /></Field>
            <Field label="Internal validation"><KSelect value={f.internal_validation} onChange={(e) => s("internal_validation", e.target.value)} options={INTERNAL_VALIDATIONS.map((x) => ({ value: x.id, label: x.label }))} /></Field>
            <Field label="Priority"><KSelect value={f.priority} onChange={(e) => s("priority", e.target.value)} options={PRIORITIES.map((x) => ({ value: x.id, label: x.label }))} /></Field>
            <Field label="Status"><KSelect value={f.status} onChange={(e) => s("status", e.target.value)} options={OBJECT_STATUSES.map((x) => ({ value: x.id, label: x.label }))} /></Field>
            <Field label="Evidence level"><KSelect value={f.evidence_level} onChange={(e) => s("evidence_level", e.target.value)} placeholder="—" options={EVIDENCE_LEVELS.map((x) => ({ value: x.id, label: x.label }))} /></Field>
            <Field label="Authority" hint="Leave as-is to derive from governance"><KSelect value={f.authority} onChange={(e) => s("authority", e.target.value)} options={AUTHORITY_LEVELS.map((x) => ({ value: x.id, label: `${x.id} — ${x.label}` }))} /></Field>
            <Field label="Effective from"><KInput type="date" value={f.effective_from} onChange={(e) => s("effective_from", e.target.value)} /></Field>
            <Field label="Effective until"><KInput type="date" value={f.effective_until} onChange={(e) => s("effective_until", e.target.value)} /></Field>
          </div>
          <KBtn
            variant="primary"
            loading={busy}
            onClick={() =>
              onSave({
                name: f.name,
                summary: f.summary,
                domain: f.domain,
                object_type: f.object_type,
                subtype: f.subtype || null,
                status: f.status,
                priority: f.priority,
                founder_endorsement: f.founder_endorsement || null,
                implementation_status: f.implementation_status,
                internal_validation: f.internal_validation,
                evidence_level: f.evidence_level || null,
                ...(f.authority !== o.authority ? { authority: f.authority } : {}),
                effective_from: f.effective_from || null,
                effective_until: f.effective_until || null,
                tags: f.tags.split(",").map((x) => x.trim()).filter(Boolean),
                applies_to: f.applies_to.split(",").map((x) => x.trim()).filter(Boolean),
                goals: f.goals.split(",").map((x) => x.trim()).filter(Boolean),
              })
            }
          >
            <Save size={14} /> Save governance
          </KBtn>
        </div>
      </Panel>
    </div>
  );
}

function RelationshipsTab({ data, busy, setBusy, reload, setError }: { data: Detail; busy: boolean; setBusy: (b: boolean) => void; reload: () => Promise<void>; setError: (e: string | null) => void }) {
  const [ref, setRef] = React.useState("");
  const [type, setType] = React.useState("related_to");
  const [note, setNote] = React.useState("");
  async function act(body: Record<string, unknown>, method: "POST" | "PATCH") {
    setBusy(true);
    try {
      await api("/api/admin/knowledge/relationships", { method, body: JSON.stringify(body) });
      await reload();
      if (method === "POST") { setRef(""); setNote(""); }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }
  const suggested = data.relationships.filter((r) => r.status === "suggested");
  const confirmed = data.relationships.filter((r) => r.status === "confirmed");
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        {suggested.length > 0 && (
          <Panel title={`Suggested by the Brain (${suggested.length})`} subtitle="Confirm, change or ignore. Only confirmed edges are followed during retrieval.">
            <ul className="space-y-2">
              {suggested.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-sm" style={{ border: `1px solid ${C.border}`, color: C.text }}>
                  <span>{r.direction === "out" ? "" : "← "}{relationshipLabel(r.relationship_type)}</span>
                  {r.other && <Link href={`/dashboard/knowledge/${r.other.id}`} className="font-mono" style={{ color: C.green }}>{r.other.ref}</Link>}
                  <span>{r.other?.name}</span>
                  {typeof r.confidence === "number" && <Chip tone="muted">{Math.round(r.confidence * 100)}%</Chip>}
                  {r.note && <span className="text-xs" style={{ color: C.muted }}>{r.note}</span>}
                  <span className="ml-auto flex items-center gap-1">
                    <KSelect value={r.relationship_type} onChange={(e) => act({ id: r.id, action: "confirm", type: e.target.value }, "PATCH")} className="h-7 w-40 text-xs" options={RELATIONSHIP_TYPES.map((t) => ({ value: t.id, label: t.label }))} />
                    <KBtn size="xs" variant="primary" disabled={busy} onClick={() => act({ id: r.id, action: "confirm" }, "PATCH")}><Check size={12} /> Confirm</KBtn>
                    <KBtn size="xs" variant="ghost" disabled={busy} onClick={() => act({ id: r.id, action: "reject" }, "PATCH")}><X size={12} /> Ignore</KBtn>
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        )}
        <Panel title={`Confirmed (${confirmed.length})`}>
          {confirmed.length === 0 ? <p className="text-xs" style={{ color: C.muted }}>No confirmed relationships yet.</p> : (
            <ul className="space-y-1.5 text-sm">
              {confirmed.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2" style={{ color: C.text }}>
                  <Link2 size={12} style={{ color: C.muted }} />
                  <span>{r.direction === "out" ? "" : "← "}{relationshipLabel(r.relationship_type)}</span>
                  {r.other && <Link href={`/dashboard/knowledge/${r.other.id}`} className="font-mono" style={{ color: C.green }}>{r.other.ref}</Link>}
                  <span>{r.other?.name}</span>
                  <Chip tone="muted">{r.origin}</Chip>
                  <KBtn size="xs" variant="ghost" disabled={busy} onClick={() => act({ id: r.id, action: "reject" }, "PATCH")} title="Remove"><X size={12} /></KBtn>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      <Panel title="Connect to another object">
        <div className="space-y-3">
          <Field label="Relationship"><KSelect value={type} onChange={(e) => setType(e.target.value)} options={RELATIONSHIP_TYPES.map((t) => ({ value: t.id, label: t.label }))} /></Field>
          <Field label="Target ref"><KInput value={ref} onChange={(e) => setRef(e.target.value.toUpperCase())} placeholder="MG-002" /></Field>
          <Field label="Note"><KInput value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <KBtn variant="primary" disabled={!ref || busy} onClick={() => act({ sourceId: data.object.id, targetRef: ref, type, note }, "POST")}><Link2 size={13} /> Add relationship</KBtn>
        </div>
      </Panel>
    </div>
  );
}

function MarkdownEditor({ initial, busy, onSave }: { initial: string; busy: boolean; onSave: (md: string) => void }) {
  const [md, setMd] = React.useState(initial);
  React.useEffect(() => setMd(initial), [initial]);
  return (
    <Panel title="Canonical markdown" subtitle="Frontmatter is regenerated from governance on save; sections (## headings) become the semantic chunks. Saving re-chunks and re-embeds the object in place." padded={false} actions={<KBtn variant="primary" loading={busy} onClick={() => onSave(md)}><RefreshCw size={13} /> Save & re-index</KBtn>}>
      <KTextarea rows={32} value={md} onChange={(e) => setMd(e.target.value)} className="rounded-none border-0 font-mono text-xs" style={{ background: C.bg }} />
    </Panel>
  );
}
