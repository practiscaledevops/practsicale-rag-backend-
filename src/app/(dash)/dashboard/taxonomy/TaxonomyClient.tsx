"use client";

import * as React from "react";
import { Check, X, Plus } from "lucide-react";
import { DOMAINS, OBJECT_TYPES, SUGGESTED_SUBTYPES, INTELLIGENCE_CLASSES } from "@/lib/intelligence-taxonomy";
import { C, Chip, KBtn, KInput, KSelect, KTabs, Field, Panel, Empty, Spinner, ErrorNote, api, classTone, CLASS_LABEL, humanize } from "@/components/ui/brain-ui";

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

  return (
    <div className="space-y-4">
      <KTabs value={view} onChange={setView} tabs={[{ id: "queue", label: "Approval queue", count: proposed.length }, { id: "extensions", label: "Org extensions", count: approved.length }, { id: "predefined", label: "Predefined" }]} />
      {data?.migrationMissing && <ErrorNote message="Apply Brain migration 0017_operating_intelligence.sql to store taxonomy extensions." />}
      <ErrorNote message={error} />
      {!data && <Spinner />}

      {data && view === "queue" && (
        <Panel title="Proposed by the compiler" subtitle="Approve to make the value canonical; reject to keep it out. Objects already carry the value either way.">
          {proposed.length === 0 ? <Empty title="Nothing waiting" hint="New subtypes the AI proposes during ingestion will appear here." /> : (
            <ul className="space-y-2">
              {proposed.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-sm" style={{ border: `1px solid ${C.border}`, color: C.text }}>
                  <Chip tone="amber">{v.kind}</Chip>
                  <span className="font-medium">{humanize(v.value)}</span>
                  <span className="text-xs" style={{ color: C.muted }}>{[v.domain, v.object_type].filter(Boolean).map((x) => humanize(x)).join(" / ") || "any"} · by {v.proposed_by} · used {usage[`${v.domain}/${v.object_type}/${v.value}`] ?? v.usage_count}×</span>
                  <span className="ml-auto flex gap-1">
                    <KBtn size="xs" variant="primary" disabled={busy} onClick={() => act({ id: v.id, action: "approve" }, "PATCH")}><Check size={12} /> Approve</KBtn>
                    <KBtn size="xs" variant="ghost" disabled={busy} onClick={() => act({ id: v.id, action: "reject" }, "PATCH")}><X size={12} /> Reject</KBtn>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {data && view === "extensions" && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel className="lg:col-span-2" title="Approved extensions" subtitle="Values added on top of the predefined taxonomy.">
            {approved.length === 0 ? <Empty title="No extensions yet" /> : (
              <ul className="space-y-1.5">
                {approved.map((v) => (
                  <li key={v.id} className="flex flex-wrap items-center gap-2 text-sm" style={{ color: C.text }}>
                    <Chip tone="green">{v.kind}</Chip>
                    <span className="font-medium">{humanize(v.value)}</span>
                    <span className="text-xs" style={{ color: C.muted }}>{[v.domain, v.object_type].filter(Boolean).map((x) => humanize(x)).join(" / ") || "any"} · used {usage[`${v.domain}/${v.object_type}/${v.value}`] ?? v.usage_count}×</span>
                    <KBtn size="xs" variant="ghost" disabled={busy} className="ml-auto" onClick={() => act({ id: v.id, action: "reject" }, "PATCH")} title="Retire"><X size={12} /></KBtn>
                  </li>
                ))}
              </ul>
            )}
            {rejected.length > 0 && <p className="mt-3 text-[11px]" style={{ color: C.muted }}>{rejected.length} rejected value(s) hidden.</p>}
          </Panel>
          <Panel title="Add a value" subtitle="Domains and types added here are selectable in Add knowledge and offered to the AI classifier.">
            <div className="space-y-3">
              <Field label="Kind"><KSelect value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} options={["domain", "object_type", "subtype", "audience", "applies_to", "goal", "platform", "format", "business_function", "tag"].map((k) => ({ value: k, label: humanize(k) }))} /></Field>
              {form.kind === "object_type" && (
                <Field label="For class" hint="Leave blank for any class"><KSelect value={form.intelligenceClass} onChange={(e) => setForm({ ...form, intelligenceClass: e.target.value })} placeholder="Any class" options={INTELLIGENCE_CLASSES.filter((c) => c.id !== "raw_archive").map((c) => ({ value: c.id, label: c.label }))} /></Field>
              )}
              {form.kind === "subtype" && (
                <>
                  <Field label="Domain"><KSelect value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="—" options={DOMAINS.map((d) => ({ value: d.id, label: d.label }))} /></Field>
                  <Field label="Type"><KSelect value={form.objectType} onChange={(e) => setForm({ ...form, objectType: e.target.value })} placeholder="—" options={OBJECT_TYPES.map((t) => ({ value: t.id, label: t.label }))} /></Field>
                </>
              )}
              <Field label="Value"><KInput value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder={form.kind === "domain" ? "e.g. partnerships" : form.kind === "object_type" ? "e.g. scorecard" : "decision_rights"} /></Field>
              <Field label="Label (optional)"><KInput value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field>
              <KBtn variant="primary" disabled={!form.value || busy} onClick={() => act({ kind: form.kind, value: form.value, label: form.label, domain: form.domain || null, objectType: form.objectType || null, intelligenceClass: form.intelligenceClass || null }, "POST")}><Plus size={13} /> Add</KBtn>
            </div>
          </Panel>
        </div>
      )}

      {data && view === "predefined" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Intelligence classes">
            <ul className="space-y-2">{INTELLIGENCE_CLASSES.map((c) => <li key={c.id} className="text-sm" style={{ color: C.text }}><Chip tone={classTone(c.id)}>{CLASS_LABEL[c.id]}</Chip> <span className="text-xs" style={{ color: C.muted }}>{c.question}</span></li>)}</ul>
          </Panel>
          <Panel title="Domains" subtitle="What the knowledge is ABOUT — never where it was found.">
            <div className="flex flex-wrap gap-1.5">{DOMAINS.map((d) => <Chip key={d.id} tone="muted" title={`ref prefix ${d.prefix}`}>{d.label} <span style={{ color: C.green }}>{d.prefix}</span></Chip>)}</div>
          </Panel>
          <Panel title="Object types" subtitle="By class. Content-specialised types apply to the content domain only.">
            {INTELLIGENCE_CLASSES.filter((c) => c.id !== "raw_archive").map((c) => (
              <div key={c.id} className="mb-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: C.muted }}>{c.label}</p>
                <div className="mt-1 flex flex-wrap gap-1">{OBJECT_TYPES.filter((t) => t.classes.includes(c.id)).map((t) => <Chip key={t.id} tone={t.contentOnly ? "mint" : "muted"}>{t.label}</Chip>)}</div>
              </div>
            ))}
          </Panel>
          <Panel title="Suggested subtypes" subtitle="Seed values per domain/type; usage counts from your objects.">
            <ul className="space-y-1.5 text-xs">
              {Object.entries(SUGGESTED_SUBTYPES).map(([k, vals]) => (
                <li key={k} style={{ color: C.text }}>
                  <span className="font-mono" style={{ color: C.green }}>{k}</span>: {vals.map((v) => `${humanize(v)}${usage[`${k}/${v}`] ? ` (${usage[`${k}/${v}`]})` : ""}`).join(", ")}
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      )}
    </div>
  );
}
