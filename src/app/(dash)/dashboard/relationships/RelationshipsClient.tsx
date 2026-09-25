"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Link2, Loader2, Network, Plus, X } from "lucide-react";
import { RELATIONSHIP_TYPES, relationshipLabel } from "@/lib/intelligence-taxonomy";
import {
  Alert,
  Badge,
  BulkActionBar,
  Button,
  ClassBadge,
  Dialog,
  EmptyState,
  Field,
  FilterTabs,
  IconButton,
  InlineError,
  Input,
  Notice,
  PageHeader,
  RowSelectCell,
  Select,
  SelectAllCell,
  Spinner,
  Table,
  TableCard,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  SELECTED_ROW_CLASS,
  focusAfterRemoval,
  refocusRow,
  useBulkRun,
  useConfirm,
  usePendingIds,
  useSelection,
  type BulkAction,
} from "@/components/ui";
import { HttpError, bulkErrorMessage, requestJson, type BulkFailure, type BulkVerbs } from "@/lib/bulk";
import { fmtInt, humanize } from "@/lib/format";

const API = "/api/admin/knowledge/relationships";

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
/** PATCH { ids, action } reply: the ids updated in this org, and per-id failures. */
interface BulkResp { ids?: string[]; failed?: BulkFailure[] }

type Status = "suggested" | "confirmed" | "rejected";
type Review = "confirm" | "reject";
/** What a row is doing right now: drives its spinner and the type select's shown value. */
interface RowWork { action: Review; type?: string }

const ORIGIN_LABEL: Record<string, string> = {
  ai: "AI suggested",
  system: "Automatic",
  markdown: "From markdown",
  user: "Manual",
};

const TYPE_OPTIONS = RELATIONSHIP_TYPES.map((r) => ({ value: r.id, label: r.label }));

const EMPTY_FORM = { sourceRef: "", type: "related_to", targetRef: "", note: "" };

/** Quiet reload shortly after local changes, coalescing a burst of row actions into one request. */
const REFRESH_DELAY_MS = 400;

const TABLE_LINK =
  "rounded-sm font-medium text-foreground hover:text-accent-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function ObjectCell({ stub, withClass }: { stub: Stub | undefined; withClass?: boolean }) {
  if (!stub) return <span className="text-muted-foreground">Unknown object</span>;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-mono text-xs text-muted-foreground">{stub.ref}</span>
      <Link href={`/dashboard/knowledge/${stub.id}`} className={TABLE_LINK}>
        {stub.name}
      </Link>
      {withClass && <ClassBadge klass={stub.intelligence_class} />}
    </div>
  );
}

/** `rec` without `ids` (the same object when none of them are in it). */
function omit<T>(rec: Record<string, T>, ids: readonly string[]): Record<string, T> {
  if (!ids.some((id) => id in rec)) return rec;
  const next = { ...rec };
  for (const id of ids) delete next[id];
  return next;
}

/** `set` without `id` (the same set when it is not there). */
function withoutId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
}

export function RelationshipsClient() {
  const [status, setStatus] = React.useState<Status>("suggested");
  // The rows AND the tab they were loaded for, so a tab switch never shows the
  // previous tab's rows with the new tab's actions.
  const [view, setView] = React.useState<{ status: Status; resp: Resp } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [work, setWork] = React.useState<Record<string, RowWork>>({});
  const [rowErrors, setRowErrors] = React.useState<Record<string, string>>({});
  /** Rows whose error came from a bulk run: shown, not announced (the bar announces the run). */
  const [quietIds, setQuietIds] = React.useState<ReadonlySet<string>>(() => new Set());
  /** A type picked in a row's select, not saved yet: the row's Confirm saves it. */
  const [picked, setPicked] = React.useState<Record<string, string>>({});
  const [bulkType, setBulkType] = React.useState("");
  const [addOpen, setAddOpen] = React.useState(false);
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [adding, setAdding] = React.useState(false);
  const [addError, setAddError] = React.useState<string | null>(null);
  const formId = React.useId();
  const pending = usePendingIds();
  const bulk = useBulkRun();
  const { confirm, dialog } = useConfirm();

  // Only the newest load may land. A local change bumps this too, so a load
  // that started before the change can never put the old rows back.
  const loadSeq = React.useRef(0);
  const load = React.useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const resp = await requestJson<Resp>(`${API}?status=${status}`);
      if (seq !== loadSeq.current) return;
      setView({ status, resp });
      setError(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      if (e instanceof HttpError && (e.body as Partial<Resp> | null)?.migrationMissing) {
        setView({ status, resp: { edges: [], objects: {}, counts: {}, migrationMissing: true } });
        setError(null);
        return;
      }
      setError(bulkErrorMessage(e, "Failed to load"));
    }
  }, [status]);
  React.useEffect(() => {
    void load();
  }, [load]);

  const loadRef = React.useRef(load);
  React.useEffect(() => {
    loadRef.current = load;
  }, [load]);
  const refreshTimer = React.useRef<number | undefined>(undefined);
  const refreshSoon = React.useCallback(() => {
    loadSeq.current++;
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => void loadRef.current(), REFRESH_DELAY_MS);
  }, []);
  React.useEffect(() => () => window.clearTimeout(refreshTimer.current), []);

  const resetBulk = bulk.reset;
  // Row errors and the finished bulk result (with its "Retry failed") belong
  // to the tab they were raised on.
  React.useEffect(() => {
    setRowErrors({});
    setQuietIds(new Set());
    resetBulk();
  }, [status, resetBulk]);

  /** Take reviewed edges out of the list and move them between the tab counts, locally. */
  const applyReviewed = React.useCallback(
    (ids: readonly string[], action: Review) => {
      if (ids.length === 0) return;
      const to: Status = action === "confirm" ? "confirmed" : "rejected";
      const done = new Set(ids);
      setView((v) => {
        if (!v) return v;
        const moved = v.resp.edges.filter((e) => done.has(e.id) && e.status !== to);
        if (moved.length === 0) return v;
        const counts = { ...v.resp.counts };
        for (const e of moved) {
          counts[e.status] = Math.max(0, (counts[e.status] ?? 0) - 1);
          counts[to] = (counts[to] ?? 0) + 1;
        }
        const gone = new Set(moved.map((e) => e.id));
        return { ...v, resp: { ...v.resp, edges: v.resp.edges.filter((e) => !gone.has(e.id)), counts } };
      });
      setRowErrors((prev) => omit(prev, ids));
      setPicked((prev) => omit(prev, ids));
      refreshSoon();
    },
    [refreshSoon]
  );

  const edges = view && view.status === status ? view.resp.edges : [];
  const sel = useSelection(edges.map((e) => e.id));

  /** One row: only this row is busy; every other row stays usable. */
  async function review(e: Edge, action: Review, type?: string) {
    // Focus moves to the next row's Confirm / Reject button, never to its type
    // select (arrowing through a select must never confirm anything).
    const focusKey = action;
    let failed = false as boolean; // (a cast: TS does not see the assignment in the callback)
    await pending.run(e.id, async () => {
      setWork((w) => ({ ...w, [e.id]: { action, type } }));
      setRowErrors((prev) => omit(prev, [e.id]));
      setQuietIds((prev) => withoutId(prev, e.id));
      try {
        await requestJson(API, { method: "PATCH", json: type ? { id: e.id, action, type } : { id: e.id, action } });
        focusAfterRemoval(e.id, focusKey);
        applyReviewed([e.id], action);
        if (type) setNotice(`Saved: confirmed as “${relationshipLabel(type)}”.`);
      } catch (err) {
        failed = true;
        const msg = bulkErrorMessage(err);
        setRowErrors((prev) => ({ ...prev, [e.id]: type ? `Couldn't save the new type: ${msg}` : msg }));
      } finally {
        setWork((w) => omit(w, [e.id]));
      }
    });
    // The row stays after an error: give focus back to the button that was pressed.
    if (failed) refocusRow(e.id, focusKey);
  }

  /** The selection, ≤200 ids per request to the bulk PATCH. */
  function reviewSelected(action: Review, type?: string) {
    const verbs: BulkVerbs =
      action === "confirm"
        ? { running: "Confirming", done: "confirmed" }
        : status === "confirmed"
          ? { running: "Removing", done: "removed" }
          : { running: "Rejecting", done: "rejected" };
    return bulk.runChunks(
      // Rows a single-row action is still working on are left to that request.
      sel.selectedIds.filter((id) => !pending.isPending(id)),
      async (batch, signal) => {
        const r = await requestJson<BulkResp>(API, {
          method: "PATCH",
          json: type ? { ids: batch, action, type } : { ids: batch, action },
          signal,
        });
        return { ok: r?.ids ?? [], failed: r?.failed ?? [] };
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

  async function removeSelected() {
    const n = sel.count;
    const ok = await confirm({
      title: `Remove ${fmtInt(n)} confirmed ${n === 1 ? "link" : "links"}?`,
      description:
        "Removed links are no longer followed during retrieval. They move to Rejected, where you can confirm them again.",
      confirmLabel: n === 1 ? "Remove link" : `Remove ${fmtInt(n)} links`,
      tone: "danger",
    });
    if (ok) void reviewSelected("reject");
  }

  async function addLink() {
    if (!form.sourceRef || !form.targetRef || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      await requestJson(API, { method: "POST", json: form });
      setNotice(`Linked ${form.sourceRef} → ${form.targetRef}.`);
      setForm((f) => ({ ...EMPTY_FORM, type: f.type }));
      setAddOpen(false);
      refreshSoon();
    } catch (e) {
      setAddError(bulkErrorMessage(e));
    } finally {
      setAdding(false);
    }
  }

  function closeAdd() {
    if (adding) return;
    setAddOpen(false);
    setAddError(null);
  }

  const counts = view?.resp.counts ?? {};
  const objects = view?.resp.objects ?? {};
  const O = (id: string): Stub | undefined => objects[id];
  const refOf = (id: string) => O(id)?.ref ?? "unknown";
  const loadingTab = !view || view.status !== status;

  const actions: BulkAction[] = [
    {
      key: "confirm",
      label: bulkType ? `Confirm as ${relationshipLabel(bulkType)}` : "Confirm",
      icon: Check,
      tone: "primary",
      hidden: status === "confirmed",
      onClick: () => void reviewSelected("confirm", bulkType || undefined),
    },
    {
      key: "reject",
      label: status === "confirmed" ? "Remove" : "Reject",
      icon: X,
      tone: status === "confirmed" ? "danger" : "default",
      hidden: status === "rejected",
      onClick: () => void (status === "confirmed" ? removeSelected() : reviewSelected("reject")),
    },
  ];

  return (
    <div className="min-w-0">
      <PageHeader
        title="Relationships"
        description="How knowledge connects: MG-001 complements MG-002, is implemented in IMP-014 and validated by EXP-032. Links the AI suggests wait here for your review."
        actions={
          <Button size="toolbar" onClick={() => setAddOpen(true)}>
            <Plus size={14} aria-hidden />
            Add relationship
          </Button>
        }
      />
      <div className="min-w-0 space-y-3">
        <FilterTabs
          label="Relationship status"
          value={status}
          onChange={setStatus}
          tabs={[
            { id: "suggested", label: "Suggested", count: counts.suggested },
            { id: "confirmed", label: "Confirmed", count: counts.confirmed },
            { id: "rejected", label: "Rejected", count: counts.rejected },
          ]}
        />
        {view?.resp.migrationMissing && (
          <Alert tone="info" title="Not enabled yet">
            <p>Relationships aren&apos;t set up in this workspace&apos;s database yet.</p>
            <details className="mt-1">
              <summary className="cursor-pointer text-xs font-medium text-foreground">Technical details</summary>
              <p className="mt-1 text-xs">
                Apply Brain migration <code className="font-mono">0017_operating_intelligence.sql</code> to enable
                relationships.
              </p>
            </details>
          </Alert>
        )}
        {notice && <Notice message={notice} onDone={() => setNotice(null)} />}
        {error && (
          <Alert tone="danger" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}
        {loadingTab ? (
          !error && <Spinner label="Loading relationships…" />
        ) : edges.length === 0 ? (
          <EmptyState
            icon={Network}
            title={status === "suggested" ? "No suggestions waiting" : `No ${status} relationships`}
            description="The compiler suggests links when a new object is semantically close to an existing one; enrichment, conflict and learning links are created automatically."
          />
        ) : (
          <TableCard
            title={`${humanize(status)} relationships`}
            meta={status === "suggested" ? "Change a link's type if needed, then Confirm to save it." : undefined}
          >
            <Table caption={`${humanize(status)} relationships`} minWidth={880}>
              <THead>
                <tr>
                  <SelectAllCell {...sel.selectAllProps} label={`Select all ${status} links`} />
                  <Th>Source</Th>
                  <Th>Relationship</Th>
                  <Th>Target</Th>
                  <Th>Origin</Th>
                  <Th className="text-right">
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </THead>
              <TBody>
                {edges.map((e) => {
                  const pair = `${refOf(e.source_object_id)} → ${refOf(e.target_object_id)}`;
                  const w = work[e.id];
                  const busy = pending.isPending(e.id) || bulk.isActive(e.id);
                  const rowError = rowErrors[e.id];
                  const pickedType = picked[e.id] && picked[e.id] !== e.relationship_type ? picked[e.id] : undefined;
                  return (
                    <Tr
                      key={e.id}
                      data-row-id={e.id}
                      interactive
                      aria-busy={busy || undefined}
                      className={sel.isSelected(e.id) ? SELECTED_ROW_CLASS : undefined}
                    >
                      <RowSelectCell {...sel.rowProps(e.id)} label={`Select ${pair}`} />
                      <Td>
                        <ObjectCell stub={O(e.source_object_id)} withClass />
                      </Td>
                      <Td>
                        {status === "suggested" ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <Select
                              density="compact"
                              className="w-44"
                              data-focus="type"
                              aria-label={`Relationship type for ${pair}`}
                              value={w?.type ?? picked[e.id] ?? e.relationship_type}
                              onChange={(ev) => {
                                // Only stages the type: arrow keys fire `change` on a closed
                                // select, so saving here would confirm links by accident.
                                const v = ev.target.value;
                                setPicked((p) => ({ ...p, [e.id]: v }));
                              }}
                              disabled={busy}
                              options={TYPE_OPTIONS}
                            />
                            {w?.type && (
                              <span role="status" className="text-xs text-muted-foreground">
                                Saving…
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-foreground">{relationshipLabel(e.relationship_type)}</span>
                        )}
                        <InlineError message={rowError} live={!quietIds.has(e.id)} className="mt-1" />
                        {e.note && <div className="mt-0.5 text-xs text-muted-foreground">{e.note}</div>}
                      </Td>
                      <Td>
                        <ObjectCell stub={O(e.target_object_id)} />
                      </Td>
                      <Td>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge tone="neutral">{ORIGIN_LABEL[e.origin] ?? humanize(e.origin)}</Badge>
                          {typeof e.confidence === "number" && (
                            <span className="text-xs tabular-nums text-muted-foreground">{Math.round(e.confidence * 100)}%</span>
                          )}
                        </div>
                      </Td>
                      <Td>
                        <div className="flex items-center justify-end gap-1">
                          {status !== "confirmed" && (
                            <Button
                              size="sm"
                              data-focus="confirm"
                              disabled={busy}
                              loading={w?.action === "confirm"}
                              aria-label={pickedType ? `Confirm ${pair} as ${relationshipLabel(pickedType)}` : `Confirm ${pair}`}
                              onClick={() => void review(e, "confirm", pickedType)}
                            >
                              {w?.action !== "confirm" && <Check size={14} aria-hidden />}
                              {pickedType ? `Confirm as ${relationshipLabel(pickedType)}` : "Confirm"}
                            </Button>
                          )}
                          {status !== "rejected" && (
                            <IconButton
                              size="sm"
                              data-focus="reject"
                              aria-label={status === "suggested" ? `Reject ${pair}` : `Remove ${pair}`}
                              title={status === "suggested" ? "Reject" : "Remove"}
                              disabled={busy}
                              aria-busy={w?.action === "reject" || undefined}
                              onClick={() => void review(e, "reject")}
                            >
                              {w?.action === "reject" ? (
                                <Loader2 size={14} className="animate-spin" aria-hidden />
                              ) : (
                                <X size={14} aria-hidden />
                              )}
                            </IconButton>
                          )}
                        </div>
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          </TableCard>
        )}
        <BulkActionBar
          count={sel.count}
          onClear={sel.clear}
          run={bulk}
          noun={["link", "links"]}
          label="Bulk actions for relationships"
          actions={actions}
        >
          {status !== "confirmed" && (
            <Select
              density="compact"
              className="w-44"
              aria-label="Relationship type for the selected links"
              title="Confirm the selected links with this type"
              value={bulkType}
              onChange={(ev) => setBulkType(ev.target.value)}
              disabled={bulk.running}
              placeholder="Keep each type"
              options={TYPE_OPTIONS}
            />
          )}
        </BulkActionBar>
      </div>

      <Dialog
        open={addOpen}
        onClose={closeAdd}
        title="Connect two objects"
        description="Link two objects by ref. The link is confirmed straight away."
        dismissible={!adding}
        closeOnBackdrop={false}
        footer={
          <>
            <Button variant="secondary" size="toolbar" onClick={closeAdd} disabled={adding}>
              Cancel
            </Button>
            <Button type="submit" form={formId} size="toolbar" loading={adding} disabled={!form.sourceRef || !form.targetRef}>
              {!adding && <Link2 size={14} aria-hidden />}
              Add relationship
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="space-y-3"
          onSubmit={(ev) => {
            ev.preventDefault();
            void addLink();
          }}
        >
          <Field label="Source ref" hint="The ref of the object the link starts from, as shown on Knowledge objects (e.g. MG-001).">
            <Input value={form.sourceRef} onChange={(e) => setForm({ ...form, sourceRef: e.target.value.toUpperCase() })} placeholder="MG-001" className="font-mono" />
          </Field>
          <Field label="Relationship">
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} options={TYPE_OPTIONS} />
          </Field>
          <Field label="Target ref" hint="The ref of the object it points to (e.g. MG-002).">
            <Input value={form.targetRef} onChange={(e) => setForm({ ...form, targetRef: e.target.value.toUpperCase() })} placeholder="MG-002" className="font-mono" />
          </Field>
          <Field label="Note">
            <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
          <InlineError message={addError} />
        </form>
      </Dialog>
      {dialog}
    </div>
  );
}
