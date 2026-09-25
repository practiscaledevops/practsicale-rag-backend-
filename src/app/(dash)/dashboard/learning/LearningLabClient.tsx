"use client";

import * as React from "react";
import Link from "next/link";
import { Plus, Check, X, Award, Lightbulb, Link2, Calculator, Sparkles, Loader2 } from "lucide-react";
import { LEARNING_RECORD_TYPES, LEARNING_STATUSES, humanize } from "@/lib/intelligence-taxonomy";
import { BULK_CONCURRENCY, BULK_MAX_IDS, bulkErrorMessage, requestJson, type BulkResult, type BulkVerbs } from "@/lib/bulk";
import {
  Alert,
  Badge,
  BulkActionBar,
  Button,
  CompactStat,
  Dialog,
  EmptyState,
  Field,
  FilterTabs,
  IconButton,
  InlineError,
  Input,
  RowCheckbox,
  RowSelectCell,
  SectionCard,
  Select,
  SelectAllCell,
  SelectAllCheckbox,
  Table,
  TableCard,
  TableSkeletonRows,
  TBody,
  Td,
  Textarea,
  Th,
  THead,
  Tr,
  SELECTED_ROW_CLASS,
  refocusRow,
  useBulkRun,
  useConfirm,
  usePendingIds,
  useSelection,
} from "@/components/ui";
import { api } from "@/components/ui/brain-ui";
import { cn } from "@/lib/utils";
import { fmtDate, fmtInt, relTime } from "@/lib/format";
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
/** The single follow-up POST's answer (compute_result fills `result` / `computed`). */
interface FollowupResp {
  existing?: boolean;
  result?: { ref: string };
  computed?: { via: "llm" | "fallback"; confidence: string };
}
/** The bulk follow-up POST's answer. */
interface FollowupBulkResp {
  done?: string[];
  failed?: { edgeId: string; error: string; status?: number }[];
  remaining?: string[];
}

/** A row action on a learning record ("bulk" = a failure reported by a bulk run). */
type RecordOp = "status" | "validate" | "reject" | "promote" | "bulk";
/** What a finished row action leaves on its row: a brief "Saved", or the error. */
type RowFeedback = { op: RecordOp; state: "saved" | "error"; message?: string };
/** A change to a record (and its object) shown before / after the server confirms it. */
interface RecordPatch {
  lifecycle_status?: string;
  internal_validation?: string;
  founder_endorsement?: string | null;
}

const ENDPOINT = "/api/admin/knowledge/learning";
const TYPE_ORDER = ["experiment", "implementation", "decision", "result", "learning", "adaptation", "postmortem", "standard"];
const COLS = 9;
const REF_LINK = "rounded-md font-mono text-accent-strong underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
/** Follow-ups per bulk request (the server processes them one by one). */
const FOLLOWUP_BATCH = 100;
/** Changes that land close together share one background refresh. */
const RELOAD_DELAY_MS = 250;
const SAVED_MS = 1800;
const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_PATCHES: ReadonlyMap<string, RecordPatch> = new Map();

const PATCH_OF = {
  validate: { lifecycle_status: "validated", internal_validation: "validated" },
  reject: { lifecycle_status: "rejected", internal_validation: "rejected" },
  promote: { lifecycle_status: "validated", internal_validation: "validated", founder_endorsement: "practiscale_standard" },
} satisfies Record<string, RecordPatch>;

function applyPatch(it: Item, p: RecordPatch): Item {
  const record = p.lifecycle_status && p.lifecycle_status !== it.record.lifecycle_status ? { ...it.record, lifecycle_status: p.lifecycle_status } : it.record;
  let object = it.object;
  if (object && (p.internal_validation !== undefined || p.founder_endorsement !== undefined)) {
    object = {
      ...object,
      ...(p.internal_validation !== undefined ? { internal_validation: p.internal_validation } : {}),
      ...(p.founder_endorsement !== undefined ? { founder_endorsement: p.founder_endorsement } : {}),
    };
  }
  return record === it.record && object === it.object ? it : { record, object };
}

/** Confirmed changes written into the loaded data, status counts kept in step. */
function commitPatches(d: Resp, patches: ReadonlyMap<string, RecordPatch>): Resp {
  const byStatus = { ...d.counts.byStatus };
  const items = d.items.map((it) => {
    const p = patches.get(it.record.id);
    if (!p) return it;
    const from = it.record.lifecycle_status;
    if (p.lifecycle_status && p.lifecycle_status !== from) {
      byStatus[from] = Math.max(0, (byStatus[from] ?? 0) - 1);
      byStatus[p.lifecycle_status] = (byStatus[p.lifecycle_status] ?? 0) + 1;
    }
    return applyPatch(it, p);
  });
  return { ...d, items, counts: { ...d.counts, byStatus } };
}

/** `m` with `id` set to `v`. */
function withKey<V>(m: Record<string, V>, id: string, v: V): Record<string, V> {
  return { ...m, [id]: v };
}

/** `m` without `ids` (the same object when none of them is there). */
function withoutKeys<V>(m: Record<string, V>, ids: Iterable<string>): Record<string, V> {
  let next: Record<string, V> | null = null;
  for (const id of ids) {
    if (!(id in m)) continue;
    next ??= { ...m };
    delete next[id];
  }
  return next ?? m;
}

function withAdded(s: ReadonlySet<string>, ids: Iterable<string>): ReadonlySet<string> {
  const next = new Set(s);
  for (const id of ids) next.add(id);
  return next;
}

/** `s` without `ids` (the same set when none of them is there). */
function withRemoved(s: ReadonlySet<string>, ids: Iterable<string>): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const id of ids) {
    if (!s.has(id)) continue;
    next ??= new Set(s);
    next.delete(id);
  }
  return next ?? s;
}

/** The control that keeps focus on a record row after `op` (the clicked one may be gone). */
const FOCUS_AFTER: Record<"validate" | "reject" | "promote", string> = {
  validate: "reject",
  reject: "validate",
  promote: "promote",
};

function count(n: number, one: string, many = `${one}s`): string {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}

/** What the page says after a single follow-up action went through. */
function followupNotice(action: FollowupAction, f: Followup, r: FollowupResp | null): string | null {
  if (action === "attach_evidence") return `${f.evidence.ref} attached as evidence to ${f.record.ref}.`;
  if (action !== "compute_result") return null;
  if (r?.result) {
    return r.computed?.via === "fallback"
      ? `${r.result.ref} proposed from ${f.evidence.ref} without a model — fill in the numbers, then validate.`
      : `${r.result.ref} proposed from ${f.evidence.ref} (confidence ${r.computed?.confidence ?? "low"}) — review and validate.`;
  }
  if (r?.existing) return `A result computed from ${f.evidence.ref} already exists — the evidence is attached to ${f.record.ref}.`;
  return null;
}

export function LearningLabClient() {
  // `server` is the last loaded page; `overrides` are row changes still in
  // flight (shown right away, dropped again if the request fails); `hidden`
  // are follow-ups already acted on.
  const [server, setServer] = React.useState<Resp | null>(null);
  const [overrides, setOverrides] = React.useState<ReadonlyMap<string, RecordPatch>>(EMPTY_PATCHES);
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(EMPTY_SET);
  const [error, setError] = React.useState<string | null>(null);
  const [type, setType] = React.useState<string>("all");
  const [status, setStatus] = React.useState("");
  const [recording, setRecording] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [announce, setAnnounce] = React.useState("");
  const [recOps, setRecOps] = React.useState<Record<string, RecordOp>>({});
  const [recFeedback, setRecFeedback] = React.useState<Record<string, RowFeedback>>({});
  const [fuOps, setFuOps] = React.useState<Record<string, FollowupAction>>({});
  const [fuErrors, setFuErrors] = React.useState<Record<string, string>>({});
  /** Follow-ups whose error came from a bulk run: shown, not announced (the bar announces the run). */
  const [fuQuiet, setFuQuiet] = React.useState<ReadonlySet<string>>(EMPTY_SET);
  const [bulkStatus, setBulkStatus] = React.useState("");
  const fuScope = React.useRef<HTMLDivElement>(null);
  const recScope = React.useRef<HTMLDivElement>(null);
  const { confirm, dialog } = useConfirm();
  const recPending = usePendingIds();
  const fuPending = usePendingIds();
  const recBulk = useBulkRun();
  const fuBulk = useBulkRun();

  const loadSeq = React.useRef(0);
  const reloadTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedbackTimers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const computedRefs = React.useRef<string[]>([]);

  const load = React.useCallback(async () => {
    const seq = ++loadSeq.current;
    const p = new URLSearchParams();
    if (type !== "all") p.set("type", type);
    if (status) p.set("status", status);
    try {
      const d = await requestJson<Resp>(`${ENDPOINT}?${p}`);
      // A newer load, or a change that landed after this one started, wins.
      if (seq !== loadSeq.current || !d) return;
      setServer(d);
      setError(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(bulkErrorMessage(e, "Failed to load"));
    }
  }, [type, status]);
  const loadRef = React.useRef(load);
  React.useEffect(() => {
    loadRef.current = load;
  }, [load]);
  React.useEffect(() => {
    void load();
  }, [load]);

  /**
   * After any change: loads already in flight predate it, so drop them, and
   * refresh the list, counts and follow-up queue once in the background.
   * Nothing is disabled meanwhile.
   */
  const scheduleReload = React.useCallback(() => {
    loadSeq.current++;
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      void loadRef.current();
    }, RELOAD_DELAY_MS);
  }, []);

  React.useEffect(() => {
    const timers = feedbackTimers.current;
    const reload = reloadTimer;
    return () => {
      if (reload.current) clearTimeout(reload.current);
      for (const t of timers.values()) clearTimeout(t);
    };
  }, []);

  const setRowFeedback = React.useCallback((id: string, fb: RowFeedback | null) => {
    const timers = feedbackTimers.current;
    const t = timers.get(id);
    if (t) {
      clearTimeout(t);
      timers.delete(id);
    }
    setRecFeedback((m) => (fb ? withKey(m, id, fb) : withoutKeys(m, [id])));
    if (fb?.state === "saved") {
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          setRecFeedback((m) => (m[id]?.state === "saved" ? withoutKeys(m, [id]) : m));
        }, SAVED_MS)
      );
    }
  }, []);

  const data = React.useMemo<Resp | null>(() => {
    if (!server) return null;
    const items = overrides.size
      ? server.items.map((it) => {
          const p = overrides.get(it.record.id);
          return p ? applyPatch(it, p) : it;
        })
      : server.items;
    const followups = hidden.size && server.followups ? server.followups.filter((f) => !hidden.has(f.edgeId)) : server.followups;
    return items === server.items && followups === server.followups ? server : { ...server, items, followups };
  }, [server, overrides, hidden]);

  const items = data?.items ?? [];
  const followups = data?.followups ?? [];
  const recSel = useSelection(items.map((i) => i.record.id));
  const fuSel = useSelection(followups.map((f) => f.edgeId));

  // ── One record ────────────────────────────────────────────────────────────
  // Only that row is busy; its change shows at once and is undone if the
  // request fails (with the reason on the row).
  async function changeRecord(it: Item, op: Exclude<RecordOp, "bulk">, patch: RecordPatch, body: Record<string, unknown>) {
    const id = it.record.id;
    const name = it.object?.name ?? it.object?.ref ?? "this record";
    // The clicked control is disabled while the request runs, which drops focus
    // on <body>; put it back on the row (the next control that still exists).
    let focusKey = null as string | null; // (a cast: TS does not see the assignments in the callback)
    await recPending.run(id, async () => {
      setRecOps((m) => withKey(m, id, op));
      setRowFeedback(id, null);
      setOverrides((m) => new Map(m).set(id, patch));
      if (op === "status") setAnnounce(`Saving the status of ${name}…`);
      focusKey = op;
      try {
        await requestJson(ENDPOINT, { method: "PATCH", json: body });
        if (op !== "status") focusKey = FOCUS_AFTER[op];
        setServer((d) => d && commitPatches(d, new Map([[id, patch]])));
        setRowFeedback(id, op === "status" ? { op, state: "saved" } : null);
        setAnnounce(
          op === "status"
            ? `Status of ${name} saved`
            : op === "promote"
              ? `${name} promoted to PractiScale Standard`
              : `${name} ${op === "validate" ? "validated" : "rejected"}`
        );
      } catch (e) {
        setRowFeedback(id, { op, state: "error", message: bulkErrorMessage(e, "Update failed") });
        setAnnounce("");
      } finally {
        setOverrides((m) => {
          if (!m.has(id)) return m;
          const next = new Map(m);
          next.delete(id);
          return next;
        });
        setRecOps((m) => withoutKeys(m, [id]));
        scheduleReload();
      }
    });
    if (focusKey) refocusRow(id, focusKey);
  }

  async function promote(it: Item) {
    const r = it.record;
    const ok = await confirm({
      title: "Promote to PractiScale Standard?",
      description: `Promote ${r.related_playbook_refs.join(", ") || "the related playbooks"} to PractiScale Standard based on this ${r.record_type}?`,
      confirmLabel: "Promote",
    });
    if (ok) void changeRecord(it, "promote", PATCH_OF.promote, { id: r.id, action: "promote_standard" });
  }

  // ── Many records ──────────────────────────────────────────────────────────
  function runRecordBulk(ids: string[], change: { action: "validate" | "reject" } | { lifecycleStatus: string }, verbs: BulkVerbs) {
    const patch: RecordPatch = "action" in change ? PATCH_OF[change.action] : { lifecycle_status: change.lifecycleStatus };
    for (const id of ids) setRowFeedback(id, null);
    return recBulk.runChunks(
      ids,
      async (batch) => {
        const r = await requestJson<{ ids?: string[] } | null>(ENDPOINT, { method: "PATCH", json: { ids: batch, ...change } });
        return { ok: r?.ids ?? [] };
      },
      {
        size: BULK_MAX_IDS,
        verbs,
        missingError: "Not found — it may have been deleted",
        onSettled: (res) => {
          if (res.ok.length) setServer((d) => d && commitPatches(d, new Map(res.ok.map((id) => [id, patch]))));
          for (const f of res.failed) setRowFeedback(f.id, { op: "bulk", state: "error", message: f.error });
          recSel.settle(res);
          scheduleReload();
        },
      }
    );
  }

  function validateSelected() {
    void runRecordBulk(recSel.selectedIds, { action: "validate" }, { running: "Validating", done: "validated" });
  }

  async function rejectSelected() {
    const ids = recSel.selectedIds;
    if (!ids.length) return;
    const ok = await confirm({
      title: `Reject ${count(ids.length, "learning record")}?`,
      description: "They are marked rejected, and so are their knowledge objects' internal validation. You can set another status later.",
      confirmLabel: `Reject ${fmtInt(ids.length)}`,
      tone: "danger",
    });
    if (ok) void runRecordBulk(ids, { action: "reject" }, { running: "Rejecting", done: "rejected" });
  }

  function applyBulkStatus() {
    const next = bulkStatus;
    if (!next || !recSel.count) return;
    const label = LEARNING_STATUSES.find((s) => s.id === next)?.label ?? humanize(next);
    setBulkStatus("");
    void runRecordBulk(recSel.selectedIds, { lifecycleStatus: next }, { running: "Updating", done: `set to ${label}` });
  }

  // ── One follow-up ─────────────────────────────────────────────────────────
  // Only that follow-up is busy, even while a result is computed (a model call
  // of up to two minutes): the rest of the page stays usable.
  async function followup(action: FollowupAction, f: Followup) {
    await fuPending.run(f.edgeId, async () => {
      setFuOps((m) => withKey(m, f.edgeId, action));
      setFuErrors((m) => withoutKeys(m, [f.edgeId]));
      setFuQuiet((s) => withRemoved(s, [f.edgeId]));
      try {
        const r = await requestJson<FollowupResp | null>(ENDPOINT, { method: "POST", json: { action, edgeId: f.edgeId } });
        setHidden((s) => withAdded(s, [f.edgeId]));
        const msg = followupNotice(action, f, r);
        if (msg) setNotice(msg);
      } catch (e) {
        setFuErrors((m) => withKey(m, f.edgeId, bulkErrorMessage(e, "Action failed")));
      } finally {
        setFuOps((m) => withoutKeys(m, [f.edgeId]));
        scheduleReload();
      }
    });
  }

  // ── Many follow-ups ───────────────────────────────────────────────────────
  function settleFollowups(res: BulkResult<string>) {
    if (res.ok.length) setHidden((s) => withAdded(s, res.ok));
    if (res.failed.length) {
      setFuErrors((m) => {
        const next = { ...m };
        for (const f of res.failed) next[f.id] = f.error;
        return next;
      });
      setFuQuiet((s) => withAdded(s, res.failed.map((f) => f.id)));
    }
    fuSel.settle(res);
    scheduleReload();
  }

  function clearFollowupErrors(ids: string[]) {
    setFuErrors((m) => withoutKeys(m, ids));
    setFuQuiet((s) => withRemoved(s, ids));
  }

  /** Attach / ignore: server bulk, ≤100 per request, resent until the server has done them all. */
  function runFollowupBulk(ids: string[], action: "attach_evidence" | "ignore") {
    clearFollowupErrors(ids);
    return fuBulk.runChunks(
      ids,
      async (batch) => {
        // The batch's rows spin on the button of this action until the server answers.
        setFuOps((m) => ({ ...m, ...Object.fromEntries(batch.map((edgeId) => [edgeId, action])) }));
        try {
          const r = await requestJson<FollowupBulkResp | null>(ENDPOINT, { method: "POST", json: { action, edgeIds: batch } });
          return {
            ok: r?.done ?? [],
            failed: (r?.failed ?? []).map((f) => ({ id: f.edgeId, error: f.error, status: f.status })),
            remaining: r?.remaining ?? [],
          };
        } finally {
          setFuOps((m) => withoutKeys(m, batch));
        }
      },
      {
        size: FOLLOWUP_BATCH,
        verbs: action === "attach_evidence" ? { running: "Attaching", done: "attached" } : { running: "Ignoring", done: "ignored" },
        missingError: "Not processed — try again",
        onSettled: settleFollowups,
      }
    );
  }

  /** The selected follow-ups, minus any a single-row action is still working on. */
  function idleSelectedFollowups(): string[] {
    return fuSel.selectedIds.filter((id) => !fuPending.isPending(id));
  }

  function attachSelected() {
    void runFollowupBulk(idleSelectedFollowups(), "attach_evidence");
  }

  async function ignoreSelected() {
    const ids = idleSelectedFollowups();
    if (!ids.length) return;
    const ok = await confirm({
      title: `Ignore ${count(ids.length, "suggestion")}?`,
      description: "They leave the queue and are not proposed again.",
      confirmLabel: `Ignore ${fmtInt(ids.length)}`,
      tone: "danger",
    });
    if (ok) void runFollowupBulk(ids, "ignore");
  }

  /** Compute results: the single endpoint, one follow-up at a time (each is a model call). */
  async function computeSelected() {
    const ids = fuSel.selectedIds;
    if (!ids.length) return;
    const ok = await confirm({
      title: `Compute ${count(ids.length, "result")}?`,
      description: "Each follow-up attaches its evidence and asks the model to propose a Result record for you to validate. They run one at a time (up to two minutes each); you can keep working meanwhile.",
      confirmLabel: `Compute ${fmtInt(ids.length)}`,
    });
    if (!ok) return;
    clearFollowupErrors(ids);
    computedRefs.current = [];
    void fuBulk.run(
      ids,
      async (edgeId) => {
        // Through the per-row pending set: a follow-up already being computed
        // (or attached / ignored) from its own row is never sent a second time.
        const ran = await fuPending.run(edgeId, async () => {
          setFuOps((m) => withKey(m, edgeId, "compute_result"));
          try {
            // No abort signal: Cancel stops the queue, the result in progress still lands.
            const r = await requestJson<FollowupResp | null>(ENDPOINT, { method: "POST", json: { action: "compute_result", edgeId } });
            if (r?.result?.ref) computedRefs.current.push(r.result.ref);
            setHidden((s) => withAdded(s, [edgeId]));
            scheduleReload(); // the new Result shows up while the rest are still computing
          } finally {
            setFuOps((m) => withoutKeys(m, [edgeId]));
          }
          return true;
        });
        if (!ran) throw new Error("Already being processed");
      },
      {
        concurrency: BULK_CONCURRENCY.llm,
        verbs: { running: "Computing", done: "computed" },
        onSettled: (res) => {
          const refs = computedRefs.current.splice(0);
          if (refs.length) {
            const more = refs.length > 5 ? ` and ${fmtInt(refs.length - 5)} more` : "";
            setNotice(`${refs.slice(0, 5).join(", ")}${more} proposed from the new evidence — review and validate.`);
          }
          settleFollowups(res);
        },
      }
    );
  }

  const counts = data?.counts.byType ?? {};
  const openDecisions = items.filter((i) => i.record.record_type === "decision" && ["open", "proposed", "implementing"].includes(i.record.lifecycle_status)).length;
  const statusOptions = LEARNING_STATUSES.map((s) => ({ value: s.id, label: s.label }));

  return (
    <div className="min-w-0 space-y-4">
      {(followups.length > 0 || fuBulk.state) && (
        <div ref={fuScope} className="min-w-0">
          {followups.length > 0 && (
            <SectionCard
              icon={Sparkles}
              title="The Brain found evidence that may relate to an open experiment"
              description="New Business Reality that looks like it belongs to a decision, implementation or experiment you are still following. Nothing is linked until you confirm."
            >
              {/* Lined up with the row checkboxes: the rows' 1px border + px-3. */}
              <div className="mb-2 flex items-center pl-[13px]">
                <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
                  <SelectAllCheckbox {...fuSel.selectAllProps} label="Select all follow-ups" />
                  <span aria-hidden>Select all</span>
                </label>
              </div>
              <ul className="space-y-2">
                {followups.map((f) => {
                  const op = fuOps[f.edgeId];
                  const queued = fuBulk.isActive(f.edgeId) && !op;
                  const rowBusy = fuPending.isPending(f.edgeId) || fuBulk.isActive(f.edgeId);
                  const selected = fuSel.isSelected(f.edgeId);
                  return (
                    <li
                      key={f.edgeId}
                      className={cn(
                        "flex min-w-0 flex-wrap items-center gap-3 rounded-xl border px-3 py-2 transition-colors",
                        selected ? cn("border-accent/40", SELECTED_ROW_CLASS) : "border-border bg-surface-muted/50"
                      )}
                    >
                      <RowCheckbox
                        {...fuSel.rowProps(f.edgeId)}
                        label={`Select follow-up: ${f.evidence.ref} for ${f.record.ref}`}
                        disabled={fuPending.isPending(f.edgeId)}
                      />
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
                        <InlineError message={fuErrors[f.edgeId]} live={!fuQuiet.has(f.edgeId)} className="mt-0.5" />
                      </div>
                      <div className="flex min-w-0 flex-wrap items-center gap-1">
                        {queued && <span className="px-1 text-xs text-muted-foreground">Queued…</span>}
                        <Button size="sm" variant="secondary" disabled={rowBusy} loading={op === "attach_evidence"} onClick={() => void followup("attach_evidence", f)} title="Confirm the link and add this document to the record's evidence">
                          {op !== "attach_evidence" && <Link2 size={12} aria-hidden />} Attach evidence
                        </Button>
                        <Button size="sm" disabled={rowBusy} loading={op === "compute_result"} onClick={() => void followup("compute_result", f)} title="Attach the evidence and propose a Result record from it (you validate it)">
                          {op !== "compute_result" && <Calculator size={12} aria-hidden />} {op === "compute_result" ? "Computing…" : "Compute result"}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={rowBusy} loading={op === "ignore"} onClick={() => void followup("ignore", f)} title="Not related">
                          {op !== "ignore" && <X size={12} aria-hidden />} Ignore
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </SectionCard>
          )}
          <BulkActionBar
            count={fuSel.count}
            onClear={fuSel.clear}
            run={fuBulk}
            noun={["follow-up", "follow-ups"]}
            label="Follow-up bulk actions"
            scopeRef={fuScope}
            actions={[
              { key: "attach", label: "Attach evidence", icon: Link2, onClick: attachSelected, title: "Confirm the selected links and add their documents to the records' evidence" },
              { key: "compute", label: "Compute results", icon: Calculator, tone: "primary", onClick: () => void computeSelected(), title: "Attach and propose a Result for each, one at a time" },
              { key: "ignore", label: "Ignore", icon: X, tone: "danger", onClick: () => void ignoreSelected(), title: "Not related: drop the selected suggestions" },
            ]}
          />
        </div>
      )}
      {notice && <Alert tone="success" role="status" onDismiss={() => setNotice(null)}>{notice}</Alert>}
      {/* One polite announcement for row saves (the row shows the same text). */}
      <div aria-live="polite" className="sr-only">{announce}</div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
        <CompactStat label="Experiments" value={counts.experiment ?? 0} />
        <CompactStat label="Implementations" value={counts.implementation ?? 0} />
        <CompactStat label="Open decisions" value={openDecisions} />
        <CompactStat label="Results" value={counts.result ?? 0} />
        <CompactStat label="Learnings" value={counts.learning ?? 0} />
        <CompactStat label="Adaptations" value={counts.adaptation ?? 0} />
        <CompactStat label="Postmortems" value={counts.postmortem ?? 0} />
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <FilterTabs
          label="Record filter"
          value={type}
          onChange={setType}
          className="min-w-0"
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

      <div ref={recScope} className="min-w-0">
        {data && items.length === 0 ? (
          <EmptyState
            icon={Lightbulb}
            title="No organizational learning recorded yet"
            description={'The Brain proposes learnings during chat ("Save as Organizational Learning?"). You can also record a decision, experiment or result here.'}
            action={<Button size="toolbar" onClick={() => setRecording(true)}><Plus size={14} aria-hidden /> Record one</Button>}
          />
        ) : (
          <TableCard>
            <Table minWidth={1000} caption="Learning records" aria-busy={!data || undefined}>
              <THead>
                <tr>
                  <SelectAllCell {...recSel.selectAllProps} label="Select all learning records shown" />
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
                  items.map((it) => {
                    const { record: r, object: o } = it;
                    const name = o?.name ?? o?.ref ?? "this record";
                    const op = recOps[r.id];
                    const fb = recFeedback[r.id];
                    const rowBusy = recPending.isPending(r.id) || recBulk.isActive(r.id);
                    const statusError = fb?.state === "error" && fb.op === "status" ? fb.message : null;
                    const actionError = fb?.state === "error" && fb.op !== "status" ? fb.message : null;
                    // Validate / Reject / Promote change the status too, so the status cell says so.
                    const saving = op === "promote" ? "Promoting…" : op ? "Saving…" : recBulk.isActive(r.id) ? "Updating…" : null;
                    return (
                      <Tr key={r.id} data-row-id={r.id} interactive className={cn(recSel.isSelected(r.id) && SELECTED_ROW_CLASS)}>
                        <RowSelectCell {...recSel.rowProps(r.id)} label={`Select ${o?.ref ? `${o.ref} ` : ""}${name}`} cellClassName="align-top" />
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
                            data-focus="status"
                            value={r.lifecycle_status}
                            onChange={(e) => void changeRecord(it, "status", { lifecycle_status: e.target.value }, { id: r.id, lifecycleStatus: e.target.value })}
                            className="w-36"
                            options={statusOptions}
                            disabled={rowBusy}
                          />
                          {(saving || fb?.state === "saved") && (
                            <div aria-hidden className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                              {!saving && <Check size={12} className="text-success" />}
                              {saving ?? "Saved"}
                            </div>
                          )}
                          {statusError && <InlineError message={`Couldn't save the status: ${statusError}`} className="mt-0.5" />}
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
                            {r.lifecycle_status !== "validated" && (
                              <Button size="sm" variant="secondary" data-focus="validate" disabled={rowBusy} loading={op === "validate"} onClick={() => void changeRecord(it, "validate", PATCH_OF.validate, { id: r.id, action: "validate" })} title="Mark validated">
                                {op !== "validate" && <Check size={12} aria-hidden />} Validate
                              </Button>
                            )}
                            {r.lifecycle_status !== "rejected" && (
                              <IconButton size="sm" data-focus="reject" aria-label={`Reject ${name}`} title="Reject" disabled={rowBusy} aria-busy={op === "reject" || undefined} onClick={() => void changeRecord(it, "reject", PATCH_OF.reject, { id: r.id, action: "reject" })}>
                                {op === "reject" ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <X size={14} aria-hidden />}
                              </IconButton>
                            )}
                            {["learning", "adaptation", "result"].includes(r.record_type) && (
                              <Button size="sm" variant="secondary" data-focus="promote" disabled={rowBusy} loading={op === "promote"} title="Promote the playbooks it used to PractiScale Standard" onClick={() => void promote(it)}>
                                {op !== "promote" && <Award size={12} aria-hidden />} Promote
                              </Button>
                            )}
                          </div>
                          {actionError && <InlineError message={actionError} live={fb?.op !== "bulk"} className="mt-1" />}
                        </Td>
                      </Tr>
                    );
                  })
                )}
              </TBody>
            </Table>
          </TableCard>
        )}
        <BulkActionBar
          count={recSel.count}
          onClear={recSel.clear}
          run={recBulk}
          noun={["record", "records"]}
          label="Learning record bulk actions"
          scopeRef={recScope}
          actions={[
            { key: "validate", label: "Validate", icon: Check, tone: "primary", onClick: validateSelected, title: "Mark the selected records (and their knowledge objects) validated" },
            { key: "reject", label: "Reject", icon: X, tone: "danger", onClick: () => void rejectSelected(), title: "Mark the selected records (and their knowledge objects) rejected" },
          ]}
        >
          <Select
            density="compact"
            aria-label="New status for the selected records"
            value={bulkStatus}
            onChange={(e) => setBulkStatus(e.target.value)}
            placeholder="Set status…"
            className="w-40"
            options={statusOptions}
            disabled={recBulk.running}
          />
          <Button size="toolbar" variant="secondary" disabled={!bulkStatus || recBulk.running} onClick={applyBulkStatus}>
            Apply status
          </Button>
        </BulkActionBar>
      </div>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Lightbulb size={12} aria-hidden className="shrink-0" /> Promoting to PractiScale Standard marks the related playbooks validated + implemented (authority B1) and links them to this record.
      </p>

      {recording && <RecordModal onClose={() => setRecording(false)} onSaved={() => { setRecording(false); scheduleReload(); }} />}
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
