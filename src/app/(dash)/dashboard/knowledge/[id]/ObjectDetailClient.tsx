"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ExternalLink, FileText, Link2, RefreshCw, Save, Trash2, X } from "lucide-react";
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
  Alert,
  Badge,
  Button,
  buttonClass,
  ClassBadge,
  EmptyState,
  Field,
  IconButton,
  Input,
  Label,
  Menu,
  Notice,
  PageHeader,
  SectionCard,
  Select,
  Spinner,
  TabPanel,
  Tabs,
  Textarea,
  useConfirm,
  type BadgeTone,
  type TabItem,
} from "@/components/ui";
import { api } from "@/components/ui/brain-ui";
import { fmtDate, fmtDateTime, fmtDuration, humanize } from "@/lib/format";
import { statusTone } from "@/lib/ui-labels";

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

const TABS_ID = "object";

const TEXT_LINK =
  "rounded-sm text-accent-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const REF_LINK = `font-mono text-xs ${TEXT_LINK}`;

const ENDORSEMENT_TONE: Record<string, BadgeTone> = {
  practiscale_standard: "accent",
  approved: "success",
  interested: "neutral",
};

function learningTone(v: string): BadgeTone {
  if (v === "validated" || v === "completed") return "success";
  if (v === "rejected") return "danger";
  if (v === "implementing" || v === "measuring") return "accent";
  if (v === "archived") return "neutral";
  return "warning";
}

const ORIGIN_LABEL: Record<string, string> = {
  ai: "AI suggested",
  system: "Automatic",
  markdown: "From markdown",
  user: "Manual",
};
const originLabel = (v: string) => ORIGIN_LABEL[v] ?? humanize(v);

export function ObjectDetailClient({ id }: { id: string }) {
  const router = useRouter();
  const [data, setData] = React.useState<Detail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<Tab>("overview");
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

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
    const ok = await confirm({
      title: `Delete ${data.object.ref} "${data.object.name}"?`,
      description: "Its chunks, relationships and mentions are removed too.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api(`/api/admin/knowledge/objects/${id}`, { method: "DELETE" });
      router.push("/dashboard/knowledge");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
      setBusy(false);
    }
  }

  if (error && !data) {
    return (
      <div>
        <PageHeader title="Knowledge object" backHref="/dashboard/knowledge" backLabel="Knowledge objects" />
        <Alert tone="danger">{error}</Alert>
      </div>
    );
  }
  if (!data) {
    return (
      <div>
        <PageHeader title="Knowledge object" backHref="/dashboard/knowledge" backLabel="Knowledge objects" />
        <Spinner label="Loading object…" />
      </div>
    );
  }

  const o = data.object;
  const expired = !!o.effective_until && new Date(o.effective_until).getTime() <= Date.now();
  const suggested = data.relationships.filter((r) => r.status === "suggested");
  const confirmedLinks = data.relationships.filter((r) => r.status === "confirmed");
  const endorsement = o.founder_endorsement ? FOUNDER_ENDORSEMENTS.find((x) => x.id === o.founder_endorsement) : undefined;
  const bucketLabel = o.bucket ? REALITY_BUCKETS.find((b) => b.id === o.bucket)?.label : undefined;
  const sources = o.sources ?? [];
  const claims = o.source_claims ?? [];

  const tabs: TabItem<Tab>[] = [
    { id: "overview", label: "Overview" },
    { id: "governance", label: "Governance" },
    { id: "provenance", label: "Provenance", count: sources.length },
    { id: "relationships", label: "Relationships", count: data.relationships.length },
    { id: "entities", label: "Entities", count: data.entities.length },
    ...(o.intelligence_class === "organizational_learning" ? [{ id: "learning" as Tab, label: "Learning lifecycle" }] : []),
    { id: "log", label: "Decision log", count: data.decisions.length },
    { id: "markdown", label: "Markdown" },
  ];

  // Neutral chips for a list value; `raw` keeps the stored spelling (tags, refs).
  const chips = (items: string[], opts: { fallback?: string; raw?: boolean; mono?: boolean } = {}) =>
    items.length ? (
      <span className="flex flex-wrap gap-1">
        {items.map((a) => (
          <Badge key={a} tone="neutral" className={opts.mono ? "font-mono" : undefined}>
            {opts.raw ? a : humanize(a)}
          </Badge>
        ))}
      </span>
    ) : (
      <span className="text-muted-foreground">{opts.fallback ?? "—"}</span>
    );

  return (
    <div className="space-y-4">
      <PageHeader
        title={o.name}
        description={<span className="font-mono text-xs">{o.ref}</span>}
        backHref="/dashboard/knowledge"
        backLabel="Knowledge objects"
        actions={
          <>
            {suggested.length > 0 && (
              <Button variant="secondary" size="toolbar" onClick={() => setTab("relationships")}>
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
                {suggested.length} suggested link{suggested.length > 1 ? "s" : ""}
              </Button>
            )}
            <Menu
              label="More actions for this object"
              disabled={busy}
              items={[{ label: "Delete", icon: Trash2, danger: true, onSelect: () => void remove() }]}
            />
          </>
        }
      >
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <ClassBadge klass={o.intelligence_class} />
          <Badge tone={statusTone(o.status)}>{humanize(o.status)}</Badge>
          {endorsement && (
            <Badge tone={ENDORSEMENT_TONE[endorsement.id] ?? "neutral"} title={endorsement.hint}>
              {endorsement.label}
            </Badge>
          )}
          {/* Authority is a rank (A1 highest … C3 archive), not a status: an outlined neutral chip. */}
          <Badge tone="strong" title={authorityLabel(o.authority)}>
            Authority {o.authority}
          </Badge>
        </div>
      </PageHeader>

      <Tabs label="Object sections" idPrefix={TABS_ID} value={tab} onChange={setTab} tabs={tabs} />
      {notice && <Notice message={notice} onDone={() => setNotice(null)} />}
      {error && (
        <Alert tone="danger" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <TabPanel idPrefix={TABS_ID} id="overview" active={tab === "overview"}>
        <div className="grid gap-4 lg:grid-cols-3">
          {/* min-w-0 + break-words: a long URL or token in a section can't widen the page at 375px. */}
          <div className="min-w-0 space-y-4 break-words lg:col-span-2">
            {o.summary && (
              <SectionCard title="Summary">
                <p className="text-sm leading-relaxed text-foreground">{o.summary}</p>
              </SectionCard>
            )}
            {data.sections.length === 0 ? (
              <EmptyState
                icon={FileText}
                title="No compiled sections"
                description="Edit the markdown to add sections."
                action={
                  <Button variant="secondary" size="toolbar" onClick={() => setTab("markdown")}>
                    Open markdown
                  </Button>
                }
              />
            ) : (
              data.sections.map((s) => (
                <SectionCard key={s.heading} title={s.heading}>
                  <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{s.body}</div>
                </SectionCard>
              ))
            )}
          </div>
          <div className="space-y-4">
            <SectionCard title="Details">
              <Facts
                rows={[
                  ["Domain", domainLabel(o.domain)],
                  ["Type", typeLabel(o.object_type)],
                  ["Subtype", o.subtype ? humanize(o.subtype) : "—"],
                  ...(bucketLabel ? [["Reality bucket", bucketLabel] as [string, React.ReactNode]] : []),
                  ["Authority", `${o.authority} · ${authorityLabel(o.authority)}`],
                  ["Validation", humanize(o.internal_validation)],
                  ["Implementation", humanize(o.implementation_status)],
                  ["Priority", humanize(o.priority)],
                  ["Version", <span key="v" className="tabular-nums">v{o.version}</span>],
                  ["Chunks", <span key="c" className="tabular-nums">{data.chunkCount}</span>],
                  ["Updated", fmtDateTime(o.updated_at)],
                ]}
              />
            </SectionCard>
            <SectionCard title="Applies to and goals">
              <Facts
                rows={[
                  ["Applies to", chips(o.applies_to)],
                  ["Goals", chips(o.goals)],
                  ["Platforms", chips(o.applies_to_platforms, { fallback: "Universal" })],
                  ["Tags", chips(o.tags, { raw: true })],
                ]}
              />
            </SectionCard>
            <SectionCard
              title="Currency"
              actions={
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => patch({ verify_now: true }, "Marked as verified today")}
                >
                  <Check size={14} aria-hidden />
                  Verified today
                </Button>
              }
            >
              <Facts
                rows={[
                  ["Effective from", fmtDate(o.effective_from)],
                  [
                    "Effective until",
                    <span key="until">
                      {fmtDate(o.effective_until)}
                      {expired && <span className="ml-1.5 text-xs font-medium text-warning">Expired</span>}
                    </span>,
                  ],
                  ["Last verified", fmtDate(o.last_verified_at)],
                  ["Created", `${fmtDate(o.created_at)}${o.created_by ? ` by ${o.created_by}` : ""}`],
                ]}
              />
            </SectionCard>
            {data.relationships.length > 0 && (
              <SectionCard title="Connected knowledge">
                {confirmedLinks.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">No confirmed links yet.</p>
                ) : (
                  <ul className="space-y-1.5 text-[13px]">
                    {confirmedLinks.slice(0, 10).map((r) => (
                      <li key={r.id} className="text-foreground">
                        <span className="text-muted-foreground">
                          {r.direction === "out" ? relationshipLabel(r.relationship_type) : `← ${relationshipLabel(r.relationship_type)}`}
                        </span>{" "}
                        {r.other ? (
                          <Link href={`/dashboard/knowledge/${r.other.id}`} className={REF_LINK}>
                            {r.other.ref}
                          </Link>
                        ) : (
                          "?"
                        )}{" "}
                        {r.other?.name}
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>
            )}
          </div>
        </div>
      </TabPanel>

      {/* Editor tabs stay mounted so unsaved edits survive tab switches. */}
      <TabPanel idPrefix={TABS_ID} id="governance" active={tab === "governance"} keepMounted>
        <GovernanceEditor o={o} busy={busy} onSave={(body) => patch(body)} />
      </TabPanel>

      <TabPanel idPrefix={TABS_ID} id="provenance" active={tab === "provenance"}>
        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard title="Primary source">
            <Facts
              rows={[
                ["Expert", o.source_expert ?? "—"],
                ["Type", humanize(o.source_type)],
                ["Found on", humanize(o.source_platform)],
                ["Date", o.source_date ?? "—"],
                ["URL", o.source_url ? <ExternalUrl key="url" href={o.source_url} /> : "—"],
                ["Evidence level", humanize(o.evidence_level)],
                [
                  "Raw source",
                  o.raw_document_id ? (
                    <Link key="raw" href={`/dashboard/documents/${o.raw_document_id}`} className={TEXT_LINK}>
                      Stored separately (raw archive)
                    </Link>
                  ) : (
                    "Not stored"
                  ),
                ],
                [
                  "Compiled document",
                  o.document_id ? (
                    <Link key="doc" href={`/dashboard/documents/${o.document_id}`} className={TEXT_LINK}>
                      Open document
                    </Link>
                  ) : (
                    "—"
                  ),
                ],
              ]}
            />
          </SectionCard>
          <SectionCard
            title={`All sources (${sources.length})`}
            description="Every source that fed this object. Enrichments and duplicates add here."
          >
            {sources.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">No sources recorded.</p>
            ) : (
              <ul className="space-y-2 text-[13px]">
                {sources.map((s, i) => (
                  <li key={i} className="rounded-xl border border-border px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-foreground">
                        {[s.expert, s.type, s.platform, s.date].filter(Boolean).map(String).map((x) => humanize(x)).join(" · ") ||
                          "Unnamed source"}
                      </span>
                      {s.note && <Badge tone="neutral">{s.note}</Badge>}
                    </div>
                    {s.url && (
                      <div className="mt-0.5">
                        <ExternalUrl href={s.url} />
                      </div>
                    )}
                    {s.added_at && <div className="mt-0.5 text-xs text-muted-foreground">Added {fmtDate(s.added_at)}</div>}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
          <SectionCard
            className="lg:col-span-2"
            title="Source claims"
            description="What the source claimed. Claims stay claims until PractiScale verifies or tests them."
          >
            {claims.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">No explicit claims recorded.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {claims.map((c, i) => (
                  <li key={i} className="flex flex-wrap items-start gap-2 text-foreground">
                    <span className="min-w-0 flex-1">{c.claim}</span>
                    <Badge tone={c.verified ? "success" : c.tested ? "info" : "neutral"}>
                      {c.verified ? "Verified" : c.tested ? "Tested" : `${humanize(c.kind ?? "claim")}, unverified`}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      </TabPanel>

      <TabPanel idPrefix={TABS_ID} id="relationships" active={tab === "relationships"} keepMounted>
        <RelationshipsTab data={data} busy={busy} setBusy={setBusy} reload={load} setError={setError} />
      </TabPanel>

      <TabPanel idPrefix={TABS_ID} id="entities" active={tab === "entities"}>
        <SectionCard title="Entities mentioned" description="Who and what exist inside this knowledge.">
          {data.entities.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No entities extracted.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {data.entities.map(
                (m) =>
                  m.entity && (
                    <li key={m.id}>
                      <Link
                        href={`/dashboard/entities?id=${m.entity.id}`}
                        title={`${m.role ?? ""} ${m.value ?? ""}`.trim() || undefined}
                        className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-foreground transition-colors hover:bg-accent-soft hover:text-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {humanize(m.entity.kind)}: {m.entity.name}
                        {m.role ? ` (${m.role})` : ""}
                      </Link>
                    </li>
                  )
              )}
            </ul>
          )}
        </SectionCard>
      </TabPanel>

      {o.intelligence_class === "organizational_learning" && (
        <TabPanel idPrefix={TABS_ID} id="learning" active={tab === "learning"}>
          <SectionCard
            title="Learning lifecycle"
            description="Decision → implementation → experiment → result → learning → adaptation → PractiScale standard"
          >
            {!data.learning ? (
              <p className="text-[13px] text-muted-foreground">No lifecycle record.</p>
            ) : (
              <div className="space-y-4 text-[13px] text-foreground">
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone="neutral">{humanize(data.learning.record_type)}</Badge>
                  <Badge tone={learningTone(data.learning.lifecycle_status)}>{humanize(data.learning.lifecycle_status)}</Badge>
                  {data.learning.department && <Badge tone="neutral">{data.learning.department}</Badge>}
                  {data.learning.confidence && <Badge tone="neutral">Confidence {data.learning.confidence}</Badge>}
                </div>
                {data.learning.related_playbook_refs.length > 0 && (
                  <Facts rows={[["Playbooks used", chips(data.learning.related_playbook_refs, { raw: true, mono: true })]]} />
                )}
                {data.learning.missing_evidence.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-warning">Missing evidence</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5">
                      {data.learning.missing_evidence.map((m, i) => (
                        <li key={i}>{m}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {data.learningChain.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Chain</p>
                    <ul className="mt-1 space-y-1">
                      {data.learningChain.map((c) => (
                        <li key={c.id} className="flex flex-wrap items-center gap-1.5">
                          <span className="text-muted-foreground">{humanize(c.record_type)} ·</span>
                          {c.object ? (
                            <Link href={`/dashboard/knowledge/${c.object.id}`} className={REF_LINK}>
                              {c.object.ref}
                            </Link>
                          ) : (
                            "?"
                          )}
                          <span>{c.object?.name}</span>
                          <Badge tone="neutral">{humanize(c.lifecycle_status)}</Badge>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <Link href="/dashboard/learning" className={buttonClass({ variant: "secondary", size: "sm" })}>
                    Manage in the Learning Lab
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    Statuses: {LEARNING_STATUSES.map((s) => s.label).join(" → ")}
                  </span>
                </div>
              </div>
            )}
          </SectionCard>
        </TabPanel>
      )}

      <TabPanel idPrefix={TABS_ID} id="log" active={tab === "log"}>
        <SectionCard
          title="Decision log"
          description="Every automatic classification, dedup, taxonomy and relationship decision, inspectable."
        >
          {data.decisions.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No decisions logged.</p>
          ) : (
            <ul className="-my-2 divide-y divide-border">
              {data.decisions.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[13px] text-foreground">
                  <Badge tone="neutral">{humanize(d.stage)}</Badge>
                  <span className="font-medium">{humanize(d.decision)}</span>
                  {d.model && <span className="text-xs text-muted-foreground">{d.model}</span>}
                  {typeof d.confidence === "number" && (
                    <span className="text-xs tabular-nums text-muted-foreground">{Math.round(d.confidence * 100)}%</span>
                  )}
                  {typeof d.duration_ms === "number" && (
                    <span className="text-xs tabular-nums text-muted-foreground">{fmtDuration(d.duration_ms)}</span>
                  )}
                  <span className="ml-auto text-xs tabular-nums text-muted-foreground">{fmtDateTime(d.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </TabPanel>

      <TabPanel idPrefix={TABS_ID} id="markdown" active={tab === "markdown"} keepMounted>
        <MarkdownEditor
          initial={o.compiled_markdown ?? ""}
          busy={busy}
          onSave={(md) => patch({ compiled_markdown: md }, "Markdown saved and re-chunked")}
        />
      </TabPanel>

      {dialog}
    </div>
  );
}

/** Label / value pairs (the chatbot ObjectDrawer facts grid). */
function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
      {rows.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words text-foreground">{value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function ExternalUrl({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={`inline-flex max-w-full items-center gap-1 break-all ${TEXT_LINK}`}>
      <span className="min-w-0 break-all">{href}</span>
      <ExternalLink size={12} aria-hidden className="shrink-0" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Drafts that survive reloads
// ---------------------------------------------------------------------------

/**
 * Local edit state seeded from loaded data. The editors stay mounted across
 * tab switches, so when the data reloads (after any save on this page) the
 * draft follows the new value only if it is clean: equal to the last loaded
 * value, or exactly what was just submitted with Save. Unsaved edits are kept.
 */
function useDraft<S, D>(source: S, toDraft: (s: S) => D, equal: (a: D, b: D) => boolean, busy: boolean) {
  const [draft, setDraft] = React.useState<D>(() => toDraft(source));
  const [seen, setSeen] = React.useState<S>(source);
  const [submitted, setSubmitted] = React.useState<D | null>(null);
  const [wasBusy, setWasBusy] = React.useState(busy);

  // Adjusting state while rendering (React's "store information from previous renders" pattern).
  const sourceChanged = source !== seen;
  if (sourceChanged) {
    const clean = equal(draft, toDraft(seen)) || (submitted !== null && equal(draft, submitted));
    setSeen(source);
    setSubmitted(null);
    if (clean) setDraft(toDraft(source));
  }
  if (busy !== wasBusy) {
    setWasBusy(busy);
    // The save finished without new data (it failed): the draft is plain unsaved work again.
    if (!busy && !sourceChanged) setSubmitted(null);
  }

  const dirty = !equal(draft, toDraft(source));
  const markSubmitted = React.useCallback((d: D) => setSubmitted(() => d), []);
  return { draft, setDraft, dirty, markSubmitted };
}

function govForm(o: Detail["object"]) {
  return {
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
  };
}
type GovForm = ReturnType<typeof govForm>;

function sameGovForm(a: GovForm, b: GovForm): boolean {
  return (Object.keys(a) as (keyof GovForm)[]).every((k) => a[k] === b[k]);
}

const sameText = (a: string, b: string) => a === b;
const asText = (s: string) => s;

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

function GovernanceEditor({ o, busy, onSave }: { o: Detail["object"]; busy: boolean; onSave: (body: Record<string, unknown>) => void }) {
  const { draft: f, setDraft: setF, dirty, markSubmitted } = useDraft(o, govForm, sameGovForm, busy);
  const s = (k: keyof GovForm, v: string) => setF((x) => ({ ...x, [k]: v }));
  const types = typesFor(o.intelligence_class, f.domain);

  function save() {
    markSubmitted(f);
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
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SectionCard title="Classification">
        <div className="space-y-3">
          <Field label="Name">
            <Input value={f.name} onChange={(e) => s("name", e.target.value)} />
          </Field>
          <Field label="Summary">
            <Textarea rows={3} value={f.summary} onChange={(e) => s("summary", e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Domain">
              <Select value={f.domain} onChange={(e) => s("domain", e.target.value)} options={DOMAINS.map((d) => ({ value: d.id, label: d.label }))} />
            </Field>
            <Field label="Type">
              <Select value={f.object_type} onChange={(e) => s("object_type", e.target.value)} options={types.map((t) => ({ value: t.id, label: t.label }))} />
            </Field>
          </div>
          <Field label="Subtype">
            <Input value={f.subtype} onChange={(e) => s("subtype", e.target.value)} />
          </Field>
          <Field label="Applies to" hint="Separate values with commas.">
            <Input value={f.applies_to} onChange={(e) => s("applies_to", e.target.value)} />
          </Field>
          <Field label="Goals" hint="Separate values with commas.">
            <Input value={f.goals} onChange={(e) => s("goals", e.target.value)} />
          </Field>
          <Field label="Tags" hint="Separate values with commas.">
            <Input value={f.tags} onChange={(e) => s("tags", e.target.value)} />
          </Field>
        </div>
      </SectionCard>
      <SectionCard
        title="Governance"
        description="Do I believe in it? Founder endorsement. Have we used it? Implementation. Did it work? Validation."
      >
        <div className="space-y-3">
          <Field label="Founder endorsement">
            <Select
              value={f.founder_endorsement}
              onChange={(e) => s("founder_endorsement", e.target.value)}
              placeholder="None"
              options={FOUNDER_ENDORSEMENTS.map((x) => ({ value: x.id, label: `${x.label} — ${x.hint}` }))}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Implementation">
              <Select value={f.implementation_status} onChange={(e) => s("implementation_status", e.target.value)} options={IMPLEMENTATION_STATUSES.map((x) => ({ value: x.id, label: x.label }))} />
            </Field>
            <Field label="Internal validation">
              <Select value={f.internal_validation} onChange={(e) => s("internal_validation", e.target.value)} options={INTERNAL_VALIDATIONS.map((x) => ({ value: x.id, label: x.label }))} />
            </Field>
            <Field label="Priority">
              <Select value={f.priority} onChange={(e) => s("priority", e.target.value)} options={PRIORITIES.map((x) => ({ value: x.id, label: x.label }))} />
            </Field>
            <Field label="Status">
              <Select value={f.status} onChange={(e) => s("status", e.target.value)} options={OBJECT_STATUSES.map((x) => ({ value: x.id, label: x.label }))} />
            </Field>
            <Field label="Evidence level">
              <Select value={f.evidence_level} onChange={(e) => s("evidence_level", e.target.value)} placeholder="Not set" options={EVIDENCE_LEVELS.map((x) => ({ value: x.id, label: x.label }))} />
            </Field>
            <Field label="Authority" hint="Leave as-is to derive it from governance.">
              <Select value={f.authority} onChange={(e) => s("authority", e.target.value)} options={AUTHORITY_LEVELS.map((x) => ({ value: x.id, label: `${x.id} — ${x.label}` }))} />
            </Field>
            <Field label="Effective from">
              <Input type="date" value={f.effective_from} onChange={(e) => s("effective_from", e.target.value)} />
            </Field>
            <Field label="Effective until">
              <Input type="date" value={f.effective_until} onChange={(e) => s("effective_until", e.target.value)} />
            </Field>
          </div>
        </div>
      </SectionCard>
      <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-end gap-3 rounded-2xl border border-border bg-surface px-4 py-3 shadow-soft lg:col-span-2">
        <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">
          {dirty ? "Unsaved changes" : "Saves classification and governance together."}
        </span>
        <Button loading={busy} onClick={save}>
          {!busy && <Save size={16} aria-hidden />}
          Save governance
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

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
          <SectionCard
            title={`Suggested by the Brain (${suggested.length})`}
            description="Confirm, change or ignore. Only confirmed links are followed during retrieval."
          >
            <ul className="space-y-2">
              {suggested.map((r) => (
                <li key={r.id} className="rounded-xl border border-border px-3 py-2.5 text-[13px] text-foreground">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-muted-foreground">
                      {r.direction === "out" ? "" : "← "}
                      {relationshipLabel(r.relationship_type)}
                    </span>
                    {r.other && (
                      <Link href={`/dashboard/knowledge/${r.other.id}`} className={REF_LINK}>
                        {r.other.ref}
                      </Link>
                    )}
                    <span>{r.other?.name}</span>
                    {typeof r.confidence === "number" && (
                      <Badge tone="neutral" className="tabular-nums">
                        {Math.round(r.confidence * 100)}%
                      </Badge>
                    )}
                  </div>
                  {r.note && <p className="mt-0.5 text-xs text-muted-foreground">{r.note}</p>}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Label htmlFor={`confirm-as-${r.id}`}>Confirm as</Label>
                    <Select
                      id={`confirm-as-${r.id}`}
                      density="compact"
                      className="w-44"
                      value={r.relationship_type}
                      disabled={busy}
                      onChange={(e) => act({ id: r.id, action: "confirm", type: e.target.value }, "PATCH")}
                      options={RELATIONSHIP_TYPES.map((t) => ({ value: t.id, label: t.label }))}
                    />
                    <Button size="sm" disabled={busy} onClick={() => act({ id: r.id, action: "confirm" }, "PATCH")}>
                      <Check size={14} aria-hidden />
                      Confirm
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => act({ id: r.id, action: "reject" }, "PATCH")}>
                      <X size={14} aria-hidden />
                      Ignore
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </SectionCard>
        )}
        <SectionCard title={`Confirmed (${confirmed.length})`}>
          {confirmed.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No confirmed relationships yet.</p>
          ) : (
            <ul className="-my-1.5 divide-y divide-border">
              {confirmed.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 py-1.5 text-[13px] text-foreground">
                  <Link2 size={14} aria-hidden className="shrink-0 text-muted-foreground" />
                  <span className="text-muted-foreground">
                    {r.direction === "out" ? "" : "← "}
                    {relationshipLabel(r.relationship_type)}
                  </span>
                  {r.other && (
                    <Link href={`/dashboard/knowledge/${r.other.id}`} className={REF_LINK}>
                      {r.other.ref}
                    </Link>
                  )}
                  <span className="min-w-0">{r.other?.name}</span>
                  <Badge tone="neutral">{originLabel(r.origin)}</Badge>
                  <IconButton
                    size="sm"
                    className="ml-auto"
                    aria-label={`Remove relationship to ${r.other?.ref ?? "unknown object"}`}
                    title="Remove"
                    disabled={busy}
                    onClick={() => act({ id: r.id, action: "reject" }, "PATCH")}
                  >
                    <X size={14} aria-hidden />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
      <SectionCard title="Connect to another object" className="self-start">
        <div className="space-y-3">
          <Field label="Relationship">
            <Select value={type} onChange={(e) => setType(e.target.value)} options={RELATIONSHIP_TYPES.map((t) => ({ value: t.id, label: t.label }))} />
          </Field>
          <Field label="Target ref" hint="The other object's ref, as shown on Knowledge objects (e.g. MG-002).">
            <Input value={ref} onChange={(e) => setRef(e.target.value.toUpperCase())} placeholder="MG-002" className="font-mono" />
          </Field>
          <Field label="Note">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Button disabled={!ref || busy} onClick={() => act({ sourceId: data.object.id, targetRef: ref, type, note }, "POST")}>
            <Link2 size={16} aria-hidden />
            Add relationship
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function MarkdownEditor({ initial, busy, onSave }: { initial: string; busy: boolean; onSave: (md: string) => void }) {
  const { draft: md, setDraft: setMd, dirty, markSubmitted } = useDraft(initial, asText, sameText, busy);
  return (
    <SectionCard
      title="Canonical markdown"
      description="Frontmatter is regenerated from governance on save; sections (## headings) become the semantic chunks. Saving re-chunks and re-embeds the object in place."
      bodyClassName="p-0"
      actions={
        <>
          {dirty && <span className="hidden text-xs text-muted-foreground sm:inline">Unsaved changes</span>}
          <Button
            size="toolbar"
            loading={busy}
            onClick={() => {
              markSubmitted(md);
              onSave(md);
            }}
          >
            {!busy && <RefreshCw size={14} aria-hidden />}
            Save & re-index
          </Button>
        </>
      }
    >
      <Textarea
        mono
        aria-label="Canonical markdown"
        rows={32}
        value={md}
        onChange={(e) => setMd(e.target.value)}
        className="rounded-none rounded-b-2xl border-0 bg-background text-xs"
      />
    </SectionCard>
  );
}
