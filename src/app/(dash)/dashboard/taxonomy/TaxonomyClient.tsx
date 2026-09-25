"use client";

import * as React from "react";
import { Check, Inbox, Plus, Tags, X } from "lucide-react";
import {
  DOMAINS,
  OBJECT_TYPES,
  SUGGESTED_SUBTYPES,
  INTELLIGENCE_CLASSES,
  domainLabel,
  typeLabel,
} from "@/lib/intelligence-taxonomy";
import {
  Alert,
  Badge,
  Button,
  ClassBadge,
  EmptyState,
  Field,
  FilterTabs,
  IconButton,
  Input,
  SectionCard,
  Select,
  Spinner,
} from "@/components/ui";
import { api } from "@/components/ui/brain-ui";
import { humanize } from "@/lib/format";

interface ValueRow {
  id: string;
  kind: string;
  intelligence_class: string | null;
  domain: string | null;
  object_type: string | null;
  value: string;
  label: string | null;
  status: "approved" | "proposed" | "rejected";
  proposed_by: string;
  usage_count: number;
  created_at: string;
}
interface Resp {
  values: ValueRow[];
  usage: Record<string, number>;
  error?: string;
  migrationMissing?: boolean;
}

type View = "queue" | "extensions" | "predefined";

const KINDS = ["domain", "object_type", "subtype", "audience", "applies_to", "goal", "platform", "format", "business_function", "tag"];

const PROPOSER: Record<string, string> = { ai: "the AI", user: "an admin", system: "the system" };

/** "Management / Framework", or "Any domain and type" for org-wide values. */
function scopeLabel(v: Pick<ValueRow, "domain" | "object_type">): string {
  const parts = [v.domain ? domainLabel(v.domain) : null, v.object_type ? typeLabel(v.object_type) : null].filter(Boolean);
  return parts.length ? parts.join(" / ") : "Any domain and type";
}

const SUBHEAD = "text-xs font-medium text-muted-foreground";

export function TaxonomyClient() {
  const [data, setData] = React.useState<Resp | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [view, setView] = React.useState<View>("queue");
  const [busy, setBusy] = React.useState(false);
  const [form, setForm] = React.useState({ kind: "subtype", domain: "", objectType: "", value: "", label: "", intelligenceClass: "" });

  const load = React.useCallback(async () => {
    try {
      const d = await api<Resp>("/api/admin/knowledge/taxonomy");
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  async function act(body: Record<string, unknown>, method: "PATCH" | "POST") {
    setBusy(true);
    try {
      await api("/api/admin/knowledge/taxonomy", { method, body: JSON.stringify(body) });
      await load();
      if (method === "POST") setForm({ ...form, value: "", label: "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const proposed = data?.values.filter((v) => v.status === "proposed") ?? [];
  const approved = data?.values.filter((v) => v.status === "approved") ?? [];
  const rejected = data?.values.filter((v) => v.status === "rejected") ?? [];
  const usage = data?.usage ?? {};
  const usedCount = (v: ValueRow) => usage[`${v.domain}/${v.object_type}/${v.value}`] ?? v.usage_count;

  return (
    <div className="space-y-4">
      <FilterTabs
        label="View"
        value={view}
        onChange={setView}
        tabs={[
          { id: "queue", label: "Approval queue", count: proposed.length },
          { id: "extensions", label: "Org extensions", count: approved.length },
          { id: "predefined", label: "Predefined" },
        ]}
      />
      {data?.migrationMissing && (
        <Alert tone="info" title="Not enabled yet">
          <p>Taxonomy extensions can&apos;t be stored in this workspace yet.</p>
          <details className="mt-1">
            <summary className="cursor-pointer text-xs font-medium text-foreground">Technical details</summary>
            <p className="mt-1 text-xs">
              Apply Brain migration <code className="font-mono">0017_operating_intelligence.sql</code> to store taxonomy
              extensions.
            </p>
          </details>
        </Alert>
      )}
      {error && (
        <Alert tone="danger" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}
      {!data && !error && <Spinner label="Loading taxonomy…" />}

      {data && view === "queue" && (
        <SectionCard
          title="Proposed by the compiler"
          description="Approve to make a value canonical; reject to keep it out. Objects already carry the value either way."
          bodyClassName={proposed.length === 0 ? undefined : "px-4 py-1"}
        >
          {proposed.length === 0 ? (
            <EmptyState
              icon={Inbox}
              variant="plain"
              title="Nothing waiting"
              description="New subtypes the AI proposes during ingestion will appear here."
            />
          ) : (
            <ul className="divide-y divide-border">
              {proposed.map((v) => {
                const name = humanize(v.value);
                return (
                  <li key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-medium text-foreground">{name}</span>
                        <Badge tone="neutral">{humanize(v.kind)}</Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {scopeLabel(v)} · proposed by {PROPOSER[v.proposed_by] ?? humanize(v.proposed_by)} · used{" "}
                        <span className="tabular-nums">{usedCount(v)}</span>×
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button size="sm" disabled={busy} aria-label={`Approve ${name}`} onClick={() => act({ id: v.id, action: "approve" }, "PATCH")}>
                        <Check size={14} aria-hidden />
                        Approve
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busy} aria-label={`Reject ${name}`} onClick={() => act({ id: v.id, action: "reject" }, "PATCH")}>
                        <X size={14} aria-hidden />
                        Reject
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>
      )}

      {data && view === "extensions" && (
        <div className="grid gap-4 lg:grid-cols-3">
          <SectionCard
            className="lg:col-span-2"
            title="Approved extensions"
            description="Values added on top of the predefined taxonomy."
            bodyClassName={approved.length === 0 ? undefined : "px-4 py-1"}
          >
            {approved.length === 0 ? (
              <EmptyState icon={Tags} variant="plain" title="No extensions yet" description="Values you add or approve appear here." />
            ) : (
              <ul className="divide-y divide-border">
                {approved.map((v) => {
                  const name = humanize(v.value);
                  return (
                    <li key={v.id} className="flex items-center gap-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[13px] font-medium text-foreground">{name}</span>
                          <Badge tone="neutral">{humanize(v.kind)}</Badge>
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {scopeLabel(v)} · used <span className="tabular-nums">{usedCount(v)}</span>×
                        </p>
                      </div>
                      <IconButton
                        size="sm"
                        aria-label={`Retire ${name}`}
                        title="Retire"
                        disabled={busy}
                        onClick={() => act({ id: v.id, action: "reject" }, "PATCH")}
                      >
                        <X size={14} aria-hidden />
                      </IconButton>
                    </li>
                  );
                })}
              </ul>
            )}
            {rejected.length > 0 && (
              <p className="border-t border-border py-2 text-xs text-muted-foreground">
                {rejected.length} rejected {rejected.length === 1 ? "value" : "values"} hidden.
              </p>
            )}
          </SectionCard>
          <SectionCard
            className="self-start"
            title="Add a value"
            description="Domains and types added here are selectable in Add knowledge and offered to the AI classifier."
          >
            <div className="space-y-3">
              <Field label="Kind">
                <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} options={KINDS.map((k) => ({ value: k, label: humanize(k) }))} />
              </Field>
              {form.kind === "object_type" && (
                <Field label="For class" hint="Leave blank for any class.">
                  <Select
                    value={form.intelligenceClass}
                    onChange={(e) => setForm({ ...form, intelligenceClass: e.target.value })}
                    placeholder="Any class"
                    options={INTELLIGENCE_CLASSES.filter((c) => c.id !== "raw_archive").map((c) => ({ value: c.id, label: c.label }))}
                  />
                </Field>
              )}
              {form.kind === "subtype" && (
                <>
                  <Field label="Domain">
                    <Select value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="Any domain" options={DOMAINS.map((d) => ({ value: d.id, label: d.label }))} />
                  </Field>
                  <Field label="Type">
                    <Select value={form.objectType} onChange={(e) => setForm({ ...form, objectType: e.target.value })} placeholder="Any type" options={OBJECT_TYPES.map((t) => ({ value: t.id, label: t.label }))} />
                  </Field>
                </>
              )}
              <Field label="Value" hint="Saved as a slug (decision_rights). A near-duplicate reuses the existing value.">
                <Input
                  value={form.value}
                  onChange={(e) => setForm({ ...form, value: e.target.value })}
                  placeholder={form.kind === "domain" ? "e.g. partnerships" : form.kind === "object_type" ? "e.g. scorecard" : "e.g. decision_rights"}
                />
              </Field>
              <Field label="Label (optional)">
                <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
              </Field>
              <Button
                disabled={!form.value || busy}
                onClick={() => act({ kind: form.kind, value: form.value, label: form.label, domain: form.domain || null, objectType: form.objectType || null, intelligenceClass: form.intelligenceClass || null }, "POST")}
              >
                <Plus size={16} aria-hidden />
                Add value
              </Button>
            </div>
          </SectionCard>
        </div>
      )}

      {data && view === "predefined" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard title="Intelligence classes">
            <ul className="space-y-2.5">
              {INTELLIGENCE_CLASSES.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <ClassBadge klass={c.id} />
                  <span className="text-xs text-muted-foreground">{c.question}</span>
                </li>
              ))}
            </ul>
          </SectionCard>
          <SectionCard title="Domains" description="What the knowledge is about, never where it was found. The code is the ref prefix.">
            <div className="flex flex-wrap gap-1.5">
              {DOMAINS.map((d) => (
                <Badge key={d.id} tone="neutral" title={`Ref prefix ${d.prefix}`}>
                  {d.label}
                  <span className="font-mono text-foreground">{d.prefix}</span>
                </Badge>
              ))}
            </div>
          </SectionCard>
          <SectionCard title="Object types" description="By class. Outlined types apply to the content domain only.">
            <div className="space-y-3">
              {INTELLIGENCE_CLASSES.filter((c) => c.id !== "raw_archive").map((c) => {
                const types = OBJECT_TYPES.filter((t) => t.classes.includes(c.id));
                if (types.length === 0) return null;
                return (
                  <div key={c.id}>
                    <p className={SUBHEAD}>{c.label}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {types.map((t) => (
                        <Badge key={t.id} tone={t.contentOnly ? "strong" : "neutral"} title={t.contentOnly ? "Content domain only" : undefined}>
                          {t.label}
                        </Badge>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </SectionCard>
          <SectionCard title="Suggested subtypes" description="Seed values per domain and type, with how many of your objects use each.">
            <div className="space-y-3">
              {Object.entries(SUGGESTED_SUBTYPES).map(([k, vals]) => {
                const [d, t] = k.split("/");
                return (
                  <div key={k}>
                    <p className={SUBHEAD}>
                      {domainLabel(d)} / {typeLabel(t)}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {vals.map((v) => {
                        const n = usage[`${k}/${v}`];
                        return (
                          <Badge key={v} tone="neutral" title={n ? `Used by ${n} ${n === 1 ? "object" : "objects"}` : undefined}>
                            {humanize(v)}
                            {n ? <span className="tabular-nums text-foreground">{n}</span> : null}
                          </Badge>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </SectionCard>
        </div>
      )}
    </div>
  );
}
