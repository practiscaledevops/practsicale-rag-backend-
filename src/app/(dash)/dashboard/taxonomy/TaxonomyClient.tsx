"use client";

import * as React from "react";
import { Check, Inbox, Loader2, Plus, Tags, X } from "lucide-react";
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
  BulkActionBar,
  Button,
  ClassBadge,
  EmptyState,
  Field,
  FilterTabs,
  IconButton,
  InlineError,
  Input,
  RowCheckbox,
  SectionCard,
  Select,
  SelectAllCheckbox,
  Spinner,
  SELECTED_ROW_CLASS,
  focusAfterRemoval,
  refocusRow,
  useBulkRun,
  useConfirm,
  usePendingIds,
  useSelection,
  type BulkAction,
  type RowSelection,
  type SelectAllBinding,
} from "@/components/ui";
import { bulkErrorMessage, requestJson, type BulkVerbs } from "@/lib/bulk";
import { fmtInt, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";

const API = "/api/admin/knowledge/taxonomy";

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
type Review = "approve" | "reject";

const KINDS = ["domain", "object_type", "subtype", "audience", "applies_to", "goal", "platform", "format", "business_function", "tag"];

const PROPOSER: Record<string, string> = { ai: "the AI", user: "an admin", system: "the system" };

/** Quiet reload shortly after local changes, coalescing a burst of row actions into one request. */
const REFRESH_DELAY_MS = 400;

/** "Management / Framework", or "Any domain and type" for org-wide values. */
function scopeLabel(v: Pick<ValueRow, "domain" | "object_type">): string {
  const parts = [v.domain ? domainLabel(v.domain) : null, v.object_type ? typeLabel(v.object_type) : null].filter(Boolean);
  return parts.length ? parts.join(" / ") : "Any domain and type";
}

const SUBHEAD = "text-xs font-medium text-muted-foreground";

/** `rec` without `ids` (the same object when none of them are in it). */
function omit<T>(rec: Record<string, T>, ids: readonly string[]): Record<string, T> {
  if (!ids.some((id) => id in rec)) return rec;
  const next = { ...rec };
  for (const id of ids) delete next[id];
  return next;
}

/** "Select all" for the strip above a list (the list has no table head). */
function SelectAllLabel({ binding, label }: { binding: SelectAllBinding; label: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
      <SelectAllCheckbox {...binding} label={label} />
      Select all
    </label>
  );
}

/** A list row's checkbox with a comfortable hit area. */
function RowSelect({ sel, id, label }: { sel: RowSelection; id: string; label: string }) {
  return (
    <label className="-m-1 flex shrink-0 cursor-pointer items-center p-1">
      <RowCheckbox {...sel.rowProps(id)} label={label} />
    </label>
  );
}

export function TaxonomyClient() {
  const [data, setData] = React.useState<Resp | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [view, setView] = React.useState<View>("queue");
  const [form, setForm] = React.useState({ kind: "subtype", domain: "", objectType: "", value: "", label: "", intelligenceClass: "" });
  const [adding, setAdding] = React.useState(false);
  const [addError, setAddError] = React.useState<string | null>(null);
  const [work, setWork] = React.useState<Record<string, Review>>({});
  const [rowErrors, setRowErrors] = React.useState<Record<string, string>>({});
  /** Rows whose error came from a bulk run: shown, not announced (the bar announces the run). */
  const [quietIds, setQuietIds] = React.useState<ReadonlySet<string>>(() => new Set());
  /** Polite announcement of a single row's result. */
  const [live, setLive] = React.useState("");
  const pending = usePendingIds();
  const bulk = useBulkRun();
  const { confirm, dialog } = useConfirm();

  // Only the newest load may land. A local change bumps this too, so a load
  // that started before the change can never put the old statuses back.
  const loadSeq = React.useRef(0);
  const load = React.useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const d = await requestJson<Resp>(API);
      if (seq !== loadSeq.current) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(bulkErrorMessage(e, "Failed to load"));
    }
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);

  const refreshTimer = React.useRef<number | undefined>(undefined);
  const refreshSoon = React.useCallback(() => {
    loadSeq.current++;
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => void load(), REFRESH_DELAY_MS);
  }, [load]);
  React.useEffect(() => () => window.clearTimeout(refreshTimer.current), []);

  /** Move reviewed values to their new status locally (the lists are derived from it). */
  const applyReviewed = React.useCallback(
    (ids: readonly string[], action: Review) => {
      if (ids.length === 0) return;
      const status: ValueRow["status"] = action === "approve" ? "approved" : "rejected";
      const done = new Set(ids);
      setData((d) => (d ? { ...d, values: d.values.map((v) => (done.has(v.id) ? { ...v, status } : v)) } : d));
      setRowErrors((prev) => omit(prev, ids));
      refreshSoon();
    },
    [refreshSoon]
  );

  const proposed = data?.values.filter((v) => v.status === "proposed") ?? [];
  const approved = data?.values.filter((v) => v.status === "approved") ?? [];
  const rejected = data?.values.filter((v) => v.status === "rejected") ?? [];
  const usage = data?.usage ?? {};
  const usedCount = (v: ValueRow) => usage[`${v.domain}/${v.object_type}/${v.value}`] ?? v.usage_count;

  const visible = view === "queue" ? proposed : view === "extensions" ? approved : [];
  const sel = useSelection(visible.map((v) => v.id));

  /** One value: only its row is busy; every other row stays usable. */
  async function review(v: ValueRow, action: Review) {
    let failed = false as boolean; // (a cast: TS does not see the assignment in the callback)
    await pending.run(v.id, async () => {
      setWork((w) => ({ ...w, [v.id]: action }));
      setRowErrors((prev) => omit(prev, [v.id]));
      setQuietIds((prev) => {
        if (!prev.has(v.id)) return prev;
        const next = new Set(prev);
        next.delete(v.id);
        return next;
      });
      try {
        await requestJson(API, { method: "PATCH", json: { id: v.id, action } });
        // Before the row leaves its list: focus moves on to the next row.
        focusAfterRemoval(v.id, action);
        applyReviewed([v.id], action);
        setLive(
          `${action === "approve" ? "Approved" : view === "extensions" ? "Retired" : "Rejected"} ${humanize(v.value)}`
        );
      } catch (e) {
        failed = true;
        setRowErrors((prev) => ({ ...prev, [v.id]: bulkErrorMessage(e) }));
      } finally {
        setWork((w) => omit(w, [v.id]));
      }
    });
    // The row stays after an error: give focus back to the button that was pressed.
    if (failed) refocusRow(v.id, action);
  }

  /** The selection, ≤200 ids per request to the bulk PATCH. */
  function reviewSelected(action: Review, verbs: BulkVerbs) {
    return bulk.runChunks(
      // Rows a single-row action is still working on are left to that request.
      sel.selectedIds.filter((id) => !pending.isPending(id)),
      async (batch, signal) => {
        const r = await requestJson<{ ids?: string[] }>(API, { method: "PATCH", json: { ids: batch, action }, signal });
        return { ok: r?.ids ?? [] };
      },
      {
        verbs,
        onSettled: (res) => {
          applyReviewed(res.ok, action);
          sel.settle(res);
          if (res.failed.length > 0) {
            setRowErrors((prev) => {
              const next = { ...prev };
              for (const f of res.failed) next[f.id] = f.error;
              return next;
            });
            setQuietIds((prev) => new Set([...prev, ...res.failed.map((f) => f.id)]));
          }
        },
      }
    );
  }

  async function retireSelected() {
    const n = sel.count;
    const ok = await confirm({
      title: `Retire ${fmtInt(n)} ${n === 1 ? "value" : "values"}?`,
      description:
        "Retired values are no longer offered in Add knowledge or to the AI classifier. Objects that already use them keep them.",
      confirmLabel: n === 1 ? "Retire value" : `Retire ${fmtInt(n)} values`,
      tone: "danger",
    });
    if (ok) void reviewSelected("reject", { running: "Retiring", done: "retired" });
  }

  async function addValue() {
    if (!form.value || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      await requestJson(API, {
        method: "POST",
        json: {
          kind: form.kind,
          value: form.value,
          label: form.label,
          domain: form.domain || null,
          objectType: form.objectType || null,
          intelligenceClass: form.intelligenceClass || null,
        },
      });
      setForm((f) => ({ ...f, value: "", label: "" }));
      void load();
    } catch (e) {
      setAddError(bulkErrorMessage(e));
    } finally {
      setAdding(false);
    }
  }

  const actions: BulkAction[] =
    view === "queue"
      ? [
          {
            key: "approve",
            label: "Approve",
            icon: Check,
            tone: "primary",
            onClick: () => void reviewSelected("approve", { running: "Approving", done: "approved" }),
          },
          {
            key: "reject",
            label: "Reject",
            icon: X,
            onClick: () => void reviewSelected("reject", { running: "Rejecting", done: "rejected" }),
          },
        ]
      : [{ key: "retire", label: "Retire", icon: X, tone: "danger", onClick: () => void retireSelected() }];

  return (
    <div className="min-w-0 space-y-4">
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
      <p role="status" className="sr-only">
        {live}
      </p>

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
            <>
              <div className="flex items-center border-b border-border py-2">
                <SelectAllLabel binding={sel.selectAllProps} label="Select all proposed values" />
              </div>
              <ul className="divide-y divide-border">
                {proposed.map((v) => {
                  const name = humanize(v.value);
                  const busy = pending.isPending(v.id) || bulk.isActive(v.id);
                  const doing = work[v.id];
                  return (
                    <li
                      key={v.id}
                      data-row-id={v.id}
                      aria-busy={busy || undefined}
                      className={cn(
                        "-mx-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-2 py-2.5",
                        sel.isSelected(v.id) && SELECTED_ROW_CLASS
                      )}
                    >
                      <RowSelect sel={sel} id={v.id} label={`Select ${name}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[13px] font-medium text-foreground">{name}</span>
                          <Badge tone="neutral">{humanize(v.kind)}</Badge>
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {scopeLabel(v)} · proposed by {PROPOSER[v.proposed_by] ?? humanize(v.proposed_by)} · used{" "}
                          <span className="tabular-nums">{usedCount(v)}</span>×
                        </p>
                        <InlineError message={rowErrors[v.id]} live={!quietIds.has(v.id)} className="mt-1" />
                      </div>
                      <div className="ml-auto flex items-center gap-1.5">
                        <Button
                          size="sm"
                          data-focus="approve"
                          disabled={busy}
                          loading={doing === "approve"}
                          aria-label={`Approve ${name}`}
                          onClick={() => void review(v, "approve")}
                        >
                          {doing !== "approve" && <Check size={14} aria-hidden />}
                          Approve
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          data-focus="reject"
                          disabled={busy}
                          loading={doing === "reject"}
                          aria-label={`Reject ${name}`}
                          onClick={() => void review(v, "reject")}
                        >
                          {doing !== "reject" && <X size={14} aria-hidden />}
                          Reject
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </SectionCard>
      )}

      {data && view === "extensions" && (
        <div className="grid gap-4 lg:grid-cols-3">
          <SectionCard
            className="min-w-0 lg:col-span-2"
            title="Approved extensions"
            description="Values added on top of the predefined taxonomy."
            bodyClassName={approved.length === 0 ? undefined : "px-4 py-1"}
          >
            {approved.length === 0 ? (
              <EmptyState icon={Tags} variant="plain" title="No extensions yet" description="Values you add or approve appear here." />
            ) : (
              <>
                <div className="flex items-center border-b border-border py-2">
                  <SelectAllLabel binding={sel.selectAllProps} label="Select all approved extensions" />
                </div>
                <ul className="divide-y divide-border">
                  {approved.map((v) => {
                    const name = humanize(v.value);
                    const busy = pending.isPending(v.id) || bulk.isActive(v.id);
                    return (
                      <li
                        key={v.id}
                        data-row-id={v.id}
                        aria-busy={busy || undefined}
                        className={cn("-mx-2 flex items-center gap-3 rounded-lg px-2 py-2", sel.isSelected(v.id) && SELECTED_ROW_CLASS)}
                      >
                        <RowSelect sel={sel} id={v.id} label={`Select ${name}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[13px] font-medium text-foreground">{name}</span>
                            <Badge tone="neutral">{humanize(v.kind)}</Badge>
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {scopeLabel(v)} · used <span className="tabular-nums">{usedCount(v)}</span>×
                          </p>
                          <InlineError message={rowErrors[v.id]} live={!quietIds.has(v.id)} className="mt-1" />
                        </div>
                        <IconButton
                          size="sm"
                          data-focus="reject"
                          aria-label={`Retire ${name}`}
                          title="Retire"
                          disabled={busy}
                          aria-busy={work[v.id] === "reject" || undefined}
                          onClick={() => void review(v, "reject")}
                        >
                          {work[v.id] === "reject" ? (
                            <Loader2 size={14} className="animate-spin" aria-hidden />
                          ) : (
                            <X size={14} aria-hidden />
                          )}
                        </IconButton>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {rejected.length > 0 && (
              <p className="border-t border-border py-2 text-xs text-muted-foreground">
                {rejected.length} rejected {rejected.length === 1 ? "value" : "values"} hidden.
              </p>
            )}
          </SectionCard>
          <SectionCard
            className="min-w-0 self-start"
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
              <InlineError message={addError} />
              <Button disabled={!form.value} loading={adding} onClick={() => void addValue()}>
                {!adding && <Plus size={16} aria-hidden />}
                Add value
              </Button>
            </div>
          </SectionCard>
        </div>
      )}

      {data && view === "predefined" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard className="min-w-0" title="Intelligence classes">
            <ul className="space-y-2.5">
              {INTELLIGENCE_CLASSES.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <ClassBadge klass={c.id} />
                  <span className="text-xs text-muted-foreground">{c.question}</span>
                </li>
              ))}
            </ul>
          </SectionCard>
          <SectionCard className="min-w-0" title="Domains" description="What the knowledge is about, never where it was found. The code is the ref prefix.">
            <div className="flex flex-wrap gap-1.5">
              {DOMAINS.map((d) => (
                <Badge key={d.id} tone="neutral" title={`Ref prefix ${d.prefix}`}>
                  {d.label}
                  <span className="font-mono text-foreground">{d.prefix}</span>
                </Badge>
              ))}
            </div>
          </SectionCard>
          <SectionCard className="min-w-0" title="Object types" description="By class. Outlined types apply to the content domain only.">
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
          <SectionCard className="min-w-0" title="Suggested subtypes" description="Seed values per domain and type, with how many of your objects use each.">
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

      {view !== "predefined" && (
        <BulkActionBar
          count={sel.count}
          onClear={sel.clear}
          run={bulk}
          noun={["value", "values"]}
          label="Bulk actions for taxonomy values"
          actions={actions}
        />
      )}
      {dialog}
    </div>
  );
}
