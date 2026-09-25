"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtInt } from "@/lib/format";
import {
  DEFAULT_BULK_VERBS,
  bulkProgressText,
  bulkSummaryText,
  groupBulkErrors,
  pruneSelection,
  runBulk,
  runChunks,
  selectionInfo,
  setAllSelection,
  settleSelection,
  toggleSelection,
  type BulkProgress as BulkProgressEvent,
  type BulkResult,
  type BulkVerbs,
  type ChunkOutcome,
} from "@/lib/bulk";
import { Button, type ButtonVariant } from "./Button";
import { Checkbox, type CheckboxProps } from "./Checkbox";
import { IconButton } from "./IconButton";
import { Td, Th } from "./Table";

/**
 * The bulk-action kit: select many rows, act on all of them, see progress.
 *
 *   const sel = useSelection(rows.map((r) => r.id));   // pruned to visible rows
 *   const pending = usePendingIds();                   // per-row busy (never one global flag)
 *   const bulk = useBulkRun();                         // progress + Retry failed
 *
 *   <THead><Tr><SelectAllCell {...sel.selectAllProps} label="Select all suggestions" />…</Tr></THead>
 *   <Tr><RowSelectCell {...sel.rowProps(r.id)} label={`Select ${r.name}`} />…</Tr>
 *   …
 *   <BulkActionBar count={sel.count} onClear={sel.clear} run={bulk} actions={[
 *     { label: "Confirm", icon: Check, tone: "primary", onClick: () => void confirmSelected() },
 *   ]} />
 *
 * Place <BulkActionBar> AFTER the TableCard, as a child of the page column
 * (not inside the card: TableCard clips its content, so the bar could not
 * stick). It sticks to the bottom of the scrolling page while the column is
 * on screen and never covers the rail.
 */

const EMPTY: ReadonlySet<string> = new Set();

/** The bar's controls a keyboard shortcut or skip link may land on. */
const BAR_FOCUSABLE = "button:not(:disabled), select:not(:disabled), [href]";

/** The bar's first action (Clear only when there is nothing else), so Enter never clears by surprise. */
function firstBarControl(bar: Element | null | undefined): HTMLElement | null {
  if (!bar) return null;
  const all = Array.from(bar.querySelectorAll<HTMLElement>(BAR_FOCUSABLE));
  return all.find((el) => !el.hasAttribute("data-bar-clear")) ?? all[0] ?? null;
}

// ---------------------------------------------------------------------------
// useSelection
// ---------------------------------------------------------------------------

export interface ToggleOptions {
  /** Shift-click: select/deselect the range from the last toggled row. */
  shift?: boolean;
  /** On-screen order for the range (default: the ids passed to useSelection). */
  orderedIds?: readonly string[];
  /** Force the new state (default: flip the row). */
  checked?: boolean;
}

/** Spread onto <SelectAllCheckbox> / <SelectAllCell>. */
export interface SelectAllBinding {
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/** Spread onto <RowCheckbox> / <RowSelectCell>. */
export interface RowSelectBinding {
  checked: boolean;
  onCheckedChange: (checked: boolean, opts: { shift: boolean }) => void;
}

export interface RowSelection {
  /** Selected ids (only ever visible ones). */
  selected: ReadonlySet<string>;
  /** Selected ids in on-screen order: pass these to the bulk request. */
  selectedIds: string[];
  count: number;
  /** Every visible row is selected (false when the list is empty). */
  allSelected: boolean;
  /** Some, but not all, visible rows are selected (the header's mixed state). */
  someSelected: boolean;
  isSelected: (id: string) => boolean;
  toggle: (id: string, opts?: ToggleOptions) => void;
  /** Select every visible row, or none. */
  setAll: (on: boolean) => void;
  toggleAll: () => void;
  /** Add (or with `on = false` remove) these ids. */
  select: (ids: Iterable<string>, on?: boolean) => void;
  /**
   * Replace the selection outright. Not for use after a bulk run (it would drop
   * rows the admin ticked while the run was going): use `settle` there.
   */
  replace: (ids: Iterable<string>) => void;
  /**
   * After a bulk run: untick what succeeded, keep failed / skipped ticked, and
   * leave every other row as the admin set it meanwhile.
   */
  settle: (result: BulkResult<string>) => void;
  clear: () => void;
  selectAllProps: SelectAllBinding;
  rowProps: (id: string) => RowSelectBinding;
}

/**
 * Multi-select over the rows currently on screen. `ids` are the visible rows
 * in display order (after filters / tabs / search). Whenever that list
 * changes, ids that left it leave the selection, so a bulk action never
 * touches a row the admin cannot see.
 */
export function useSelection(ids: readonly string[]): RowSelection {
  const key = ids.join("\u0000");
  // `key` stands in for `ids`, which is usually a fresh array every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const visible = React.useMemo(() => ids.slice(), [key]);
  const [raw, setRaw] = React.useState<ReadonlySet<string>>(EMPTY);
  /** The last row toggled: the anchor for shift-click ranges. */
  const anchorRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    setRaw((prev) => pruneSelection(prev, visible));
    if (anchorRef.current !== null && !visible.includes(anchorRef.current)) anchorRef.current = null;
  }, [visible]);

  // Pruned at render time too, so a stale id never shows before the effect runs.
  const selected = React.useMemo(() => pruneSelection(raw, visible), [raw, visible]);
  const info = React.useMemo(() => selectionInfo(selected, visible), [selected, visible]);

  const toggle = React.useCallback(
    (id: string, opts: ToggleOptions = {}) => {
      // Read the anchor now: the updater may run after it moves on.
      const anchor = opts.shift ? anchorRef.current : null;
      const order = opts.orderedIds ?? visible;
      setRaw((prev) => toggleSelection(pruneSelection(prev, visible), id, { anchor, order, checked: opts.checked }));
      anchorRef.current = id;
    },
    [visible]
  );

  const setAll = React.useCallback(
    (on: boolean) => {
      setRaw(setAllSelection(visible, on));
      anchorRef.current = null;
    },
    [visible]
  );

  const { allSelected } = info;
  const toggleAll = React.useCallback(() => setAll(!allSelected), [setAll, allSelected]);

  const select = React.useCallback((list: Iterable<string>, on = true) => {
    const items = Array.from(list);
    setRaw((prev) => {
      const next = new Set(prev);
      for (const id of items) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const replace = React.useCallback((list: Iterable<string>) => {
    setRaw(new Set(list));
    anchorRef.current = null;
  }, []);

  const settle = React.useCallback((r: BulkResult<string>) => {
    setRaw((prev) => settleSelection(prev, r));
  }, []);

  const clear = React.useCallback(() => {
    setRaw((prev) => (prev.size ? EMPTY : prev));
    anchorRef.current = null;
  }, []);

  const isSelected = React.useCallback((id: string) => selected.has(id), [selected]);

  const selectAllProps = React.useMemo<SelectAllBinding>(
    () => ({
      checked: info.allSelected,
      indeterminate: info.someSelected,
      disabled: visible.length === 0,
      onCheckedChange: setAll,
    }),
    [info.allSelected, info.someSelected, visible.length, setAll]
  );

  const rowProps = React.useCallback(
    (id: string): RowSelectBinding => ({
      checked: selected.has(id),
      onCheckedChange: (checked, { shift }) => toggle(id, { shift, checked }),
    }),
    [selected, toggle]
  );

  return {
    selected,
    selectedIds: info.selectedIds,
    count: info.count,
    allSelected: info.allSelected,
    someSelected: info.someSelected,
    isSelected,
    toggle,
    setAll,
    toggleAll,
    select,
    replace,
    settle,
    clear,
    selectAllProps,
    rowProps,
  };
}

// ---------------------------------------------------------------------------
// usePendingIds — per-row busy state
// ---------------------------------------------------------------------------

export interface PendingIds {
  pending: ReadonlySet<string>;
  isPending: (id: string) => boolean;
  /** Anything pending at all. */
  any: boolean;
  /**
   * Mark `id` busy while `fn` runs. A second call for an id that is still
   * pending is ignored (resolves undefined without calling `fn`), so a double
   * click never sends twice. Errors from `fn` propagate.
   */
  run: <T>(id: string, fn: () => Promise<T>) => Promise<T | undefined>;
  /** Mark several ids busy while `fn` runs (always runs; counts overlap safely). */
  runMany: <T>(ids: Iterable<string>, fn: () => Promise<T>) => Promise<T>;
}

/**
 * Busy state per row, replacing a page-wide `busy` flag: acting on one row
 * disables and spins only that row, and every other row stays usable.
 */
export function usePendingIds(): PendingIds {
  // Source of truth (read synchronously by the double-click guard); the state
  // copy only drives rendering.
  const counts = React.useRef(new Map<string, number>());
  const [pending, setPending] = React.useState<ReadonlySet<string>>(EMPTY);

  const sync = React.useCallback(() => {
    setPending(counts.current.size ? new Set(counts.current.keys()) : EMPTY);
  }, []);

  const add = React.useCallback(
    (ids: readonly string[]) => {
      for (const id of ids) counts.current.set(id, (counts.current.get(id) ?? 0) + 1);
      sync();
    },
    [sync]
  );

  const remove = React.useCallback(
    (ids: readonly string[]) => {
      for (const id of ids) {
        const n = (counts.current.get(id) ?? 0) - 1;
        if (n > 0) counts.current.set(id, n);
        else counts.current.delete(id);
      }
      sync();
    },
    [sync]
  );

  const run = React.useCallback(
    async <T,>(id: string, fn: () => Promise<T>): Promise<T | undefined> => {
      if (counts.current.has(id)) return undefined;
      add([id]);
      try {
        return await fn();
      } finally {
        remove([id]);
      }
    },
    [add, remove]
  );

  const runMany = React.useCallback(
    async <T,>(ids: Iterable<string>, fn: () => Promise<T>): Promise<T> => {
      const list = Array.from(new Set(ids));
      add(list);
      try {
        return await fn();
      } finally {
        remove(list);
      }
    },
    [add, remove]
  );

  const isPending = React.useCallback((id: string) => pending.has(id), [pending]);

  return { pending, isPending, any: pending.size > 0, run, runMany };
}

// ---------------------------------------------------------------------------
// useBulkRun — one bulk operation at a time, with progress and Retry failed
// ---------------------------------------------------------------------------

export type BulkRunState =
  | { phase: "running"; verbs: BulkVerbs; total: number; done: number; ok: number; failed: number }
  | { phase: "done"; verbs: BulkVerbs; total: number; result: BulkResult<string> };

export interface BulkRunOptions {
  /** Copy for the progress line and summary (default Processing / done). */
  verbs?: BulkVerbs;
  /**
   * Called with the result of this run AND of every "Retry failed" of it:
   * update rows locally (drop `result.ok`), call `sel.settle(result)`, then
   * do ONE silent reload. Not called after the component unmounts.
   */
  onSettled?: (result: BulkResult<string>) => void | Promise<void>;
}

export interface BulkPoolOptions extends BulkRunOptions {
  /** Requests in flight (default 4). See BULK_CONCURRENCY in @/lib/bulk. */
  concurrency?: number;
}

export interface BulkChunkOptions extends BulkRunOptions {
  /** Ids per request (default 200). */
  size?: number;
  /** Error for ids missing from a batch's `ok` list. */
  missingError?: string;
}

export type BulkIdWorker = (id: string, signal: AbortSignal) => Promise<unknown>;
export type BulkBatchSender = (batch: string[], signal: AbortSignal) => Promise<ChunkOutcome<string> | void>;

export interface BulkRun {
  state: BulkRunState | null;
  running: boolean;
  /** Ids of the current run that have not settled yet (show a row spinner). */
  activeIds: ReadonlySet<string>;
  isActive: (id: string) => boolean;
  /**
   * A pool over a single-item endpoint (heavy per-item work: reingest, sync,
   * LLM compute). Ignored while another run is in progress (everything skipped).
   */
  run: (ids: readonly string[], worker: BulkIdWorker, opts?: BulkPoolOptions) => Promise<BulkResult<string>>;
  /** ≤200 ids per request to a server bulk endpoint (set-based updates). */
  runChunks: (ids: readonly string[], send: BulkBatchSender, opts?: BulkChunkOptions) => Promise<BulkResult<string>>;
  /** Re-run the last operation on its failed and cancelled ids. */
  retryFailed: () => Promise<BulkResult<string> | null>;
  /** Stop starting new items; requests already in flight finish and are reported with their real outcome. */
  cancel: () => void;
  /** Clear the finished result (no-op while running). */
  reset: () => void;
}

type BulkJob =
  | { kind: "pool"; worker: BulkIdWorker; opts: BulkPoolOptions }
  | { kind: "chunks"; send: BulkBatchSender; opts: BulkChunkOptions };

export function useBulkRun(): BulkRun {
  const [state, setState] = React.useState<BulkRunState | null>(null);
  const [activeIds, setActiveIds] = React.useState<ReadonlySet<string>>(EMPTY);
  const runningRef = React.useRef(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const lastRef = React.useRef<{ job: BulkJob; retryIds: string[] } | null>(null);
  const mountedRef = React.useRef(false);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const execute = React.useCallback(async (ids: readonly string[], job: BulkJob): Promise<BulkResult<string>> => {
    const list = Array.from(new Set(ids));
    if (list.length === 0) return { ok: [], failed: [], skipped: [], aborted: false };
    if (runningRef.current) return { ok: [], failed: [], skipped: list, aborted: false };

    runningRef.current = true;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    // Cancel stops new items / batches only. A request already sent settles with
    // the server's real answer: the server commits it even if the fetch is
    // aborted, so aborting would report done work as "cancelled".
    const requestSignal = new AbortController().signal;
    const verbs = job.opts.verbs ?? DEFAULT_BULK_VERBS;
    setActiveIds(new Set(list));
    setState({ phase: "running", verbs, total: list.length, done: 0, ok: 0, failed: 0 });

    const onProgress = (p: BulkProgressEvent<string>) => {
      if (!mountedRef.current) return;
      setState((s) => (s?.phase === "running" ? { ...s, done: p.done, ok: p.ok, failed: p.failed } : s));
      setActiveIds((prev) => {
        const next = new Set(prev);
        for (const s of p.settled) next.delete(s.id);
        return next;
      });
    };

    let result: BulkResult<string>;
    try {
      result =
        job.kind === "pool"
          ? await runBulk(list, (id) => job.worker(id, requestSignal), {
              concurrency: job.opts.concurrency,
              signal: ctrl.signal,
              onProgress,
            })
          : await runChunks(list, (batch) => job.send(batch, requestSignal), {
              size: job.opts.size,
              missingError: job.opts.missingError,
              signal: ctrl.signal,
              onProgress,
            });
    } finally {
      runningRef.current = false;
      if (abortRef.current === ctrl) abortRef.current = null;
    }

    lastRef.current = { job, retryIds: [...result.failed.map((f) => f.id), ...result.skipped] };
    if (!mountedRef.current) return result;
    setActiveIds(EMPTY);
    setState({ phase: "done", verbs, total: list.length, result });
    await job.opts.onSettled?.(result);
    return result;
  }, []);

  const run = React.useCallback(
    (ids: readonly string[], worker: BulkIdWorker, opts: BulkPoolOptions = {}) =>
      execute(ids, { kind: "pool", worker, opts }),
    [execute]
  );

  const runChunked = React.useCallback(
    (ids: readonly string[], send: BulkBatchSender, opts: BulkChunkOptions = {}) =>
      execute(ids, { kind: "chunks", send, opts }),
    [execute]
  );

  const retryFailed = React.useCallback(async () => {
    const last = lastRef.current;
    if (!last || runningRef.current || last.retryIds.length === 0) return null;
    return execute(last.retryIds, last.job);
  }, [execute]);

  const cancel = React.useCallback(() => abortRef.current?.abort(), []);

  const reset = React.useCallback(() => {
    if (!runningRef.current) setState(null);
  }, []);

  const isActive = React.useCallback((id: string) => activeIds.has(id), [activeIds]);

  return {
    state,
    running: state?.phase === "running",
    activeIds,
    isActive,
    run,
    runChunks: runChunked,
    retryFailed,
    cancel,
    reset,
  };
}

// ---------------------------------------------------------------------------
// Checkboxes + table cells
// ---------------------------------------------------------------------------

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

export interface SelectAllCheckboxProps
  extends Omit<CheckboxProps, "checked" | "defaultChecked" | "onChange" | "aria-checked"> {
  checked: boolean;
  /** Some rows selected: shows the mixed state (aria-checked="mixed"). */
  indeterminate?: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Accessible name (default "Select all"). */
  label?: string;
}

/**
 * Tri-state header checkbox on the Checkbox primitive. Clicking it in the
 * mixed state selects every visible row.
 */
export const SelectAllCheckbox = React.forwardRef<HTMLInputElement, SelectAllCheckboxProps>(
  ({ checked, indeterminate = false, onCheckedChange, label = "Select all", title, onClick, ...props }, ref) => {
    const inner = React.useRef<HTMLInputElement | null>(null);
    const mixed = indeterminate && !checked;
    // Every render: a click on a mixed box clears the DOM flag even when the
    // controlled state does not change.
    React.useEffect(() => {
      if (inner.current && inner.current.indeterminate !== mixed) inner.current.indeterminate = mixed;
    });
    const setRef = React.useCallback(
      (el: HTMLInputElement | null) => {
        inner.current = el;
        assignRef(ref, el);
      },
      [ref]
    );
    return (
      <Checkbox
        ref={setRef}
        checked={checked}
        aria-checked={mixed ? "mixed" : undefined}
        aria-label={label}
        title={title ?? label}
        onChange={(e) => onCheckedChange(e.currentTarget.checked)}
        onClick={(e) => {
          e.stopPropagation();
          onClick?.(e);
        }}
        {...props}
      />
    );
  }
);
SelectAllCheckbox.displayName = "SelectAllCheckbox";

export interface RowCheckboxProps extends Omit<CheckboxProps, "checked" | "defaultChecked" | "onChange"> {
  checked: boolean;
  /** `shift` is true for a shift-click (range select). */
  onCheckedChange: (checked: boolean, opts: { shift: boolean }) => void;
  /** Accessible name, e.g. `Select “Pricing playbook”`. */
  label: string;
}

/**
 * Row checkbox on the Checkbox primitive. Its clicks never reach the row (so
 * a clickable row does not navigate), and shift-click reports a range.
 */
export const RowCheckbox = React.forwardRef<HTMLInputElement, RowCheckboxProps>(
  ({ checked, onCheckedChange, label, onClick, onMouseDown, ...props }, ref) => (
    <Checkbox
      ref={ref}
      checked={checked}
      aria-label={label}
      // React fires onChange for checkboxes from the click event, which carries shiftKey.
      onChange={(e) =>
        onCheckedChange(e.currentTarget.checked, {
          shift: Boolean((e.nativeEvent as Partial<MouseEvent>).shiftKey),
        })
      }
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
      onMouseDown={(e) => {
        // Shift-click would otherwise select the text between the two rows.
        if (e.shiftKey) e.preventDefault();
        onMouseDown?.(e);
      }}
      {...props}
    />
  )
);
RowCheckbox.displayName = "RowCheckbox";

export interface SelectAllCellProps extends SelectAllCheckboxProps {
  cellClassName?: string;
}

/** Focus the first usable control of the first open bulk bar after `from` in the page (its own table's bar). */
function focusBarAfter(from: Element): void {
  const bars = Array.from(document.querySelectorAll<HTMLElement>("[data-bulk-bar]"));
  const bar = bars.find((b) => from.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ?? bars[0];
  firstBarControl(bar)?.focus();
}

/**
 * The header cell holding the select-all checkbox (first column). While rows
 * are selected it also holds a "Go to bulk actions" skip link, hidden until
 * focused, so keyboard users need not tab through every row to reach the bar.
 */
export function SelectAllCell({ cellClassName, ...props }: SelectAllCellProps) {
  return (
    <Th className={cn("w-10 pl-4 pr-2", cellClassName)}>
      <span className="flex items-center gap-2">
        <SelectAllCheckbox {...props} />
        {(props.checked || props.indeterminate) && (
          <button
            type="button"
            className="sr-only focus:not-sr-only focus:whitespace-nowrap focus:rounded focus:bg-surface focus:px-2 focus:text-xs focus:normal-case focus:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              focusBarAfter(e.currentTarget);
            }}
          >
            Go to bulk actions
          </button>
        )}
      </span>
    </Th>
  );
}

export interface RowSelectCellProps extends RowCheckboxProps {
  cellClassName?: string;
}

/**
 * The row's checkbox cell (first column). The whole cell is the hit area,
 * and clicks in it never trigger the row's own onClick.
 */
export function RowSelectCell({ cellClassName, ...props }: RowSelectCellProps) {
  return (
    <Td
      className={cn("w-10 p-0", props.disabled ? "cursor-not-allowed" : "cursor-pointer", cellClassName)}
      onClick={(e) => {
        e.stopPropagation();
        // On rows taller than the label, a click in the leftover cell space
        // misses the label: treat it as a toggle. Clicks on the label / input
        // take the native path (the input's own click never reaches here).
        if (e.target === e.currentTarget && !props.disabled) {
          props.onCheckedChange(!props.checked, { shift: e.shiftKey });
        }
      }}
      onMouseDown={(e) => {
        // Shift-click would otherwise select the text between the two rows.
        if (e.shiftKey && e.target === e.currentTarget) e.preventDefault();
      }}
    >
      <label className={cn("flex items-center py-2 pl-4 pr-2", props.disabled ? "cursor-not-allowed" : "cursor-pointer")}>
        <RowCheckbox {...props} />
      </label>
    </Td>
  );
}

/** The one highlight for a selected row, on every page with a selection. */
export const SELECTED_ROW_CLASS = "bg-accent-soft hover:bg-accent-soft/80";

// ---------------------------------------------------------------------------
// Row focus for review queues
// ---------------------------------------------------------------------------

function rowSelector(id: string): string {
  const safe = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
  return `[data-row-id="${safe}"]`;
}

/**
 * Keyboard focus when row `id` (a `<tr>` or `<li>` with `data-row-id`) leaves
 * its list: the same control (`data-focus={key}`) on the next row, or the
 * previous one, so Enter can walk down the queue. Call it BEFORE removing the
 * row. Only acts when focus was still in that row, or was dropped to <body> by
 * the row's disabled button.
 */
export function focusAfterRemoval(id: string, key: string): void {
  const row = document.querySelector<HTMLElement>(rowSelector(id));
  const active = document.activeElement;
  if (!row || (active && active !== document.body && !row.contains(active))) return;
  const sibling = (row.nextElementSibling ?? row.previousElementSibling) as HTMLElement | null;
  window.requestAnimationFrame(() => {
    const target =
      (sibling?.isConnected &&
        (sibling.querySelector<HTMLElement>(`[data-focus="${key}"]:not(:disabled)`) ??
          sibling.querySelector<HTMLElement>("button:not(:disabled), select:not(:disabled)"))) ||
      document.getElementById("main");
    target?.focus({ preventScroll: true });
  });
}

/**
 * Put focus back on row `id`'s `data-focus={key}` control when it was dropped
 * to <body> (its button was disabled while the request ran, then the row
 * stayed: an error, or a control that changed). Leaves focus alone otherwise.
 */
export function refocusRow(id: string, key: string): void {
  // The control re-enables on the next render, which may land a frame or two
  // later: look for a few frames, and stop as soon as focus went somewhere.
  let tries = 10;
  const attempt = () => {
    const a = document.activeElement;
    if (a && a !== document.body) return;
    const target = document.querySelector<HTMLElement>(`${rowSelector(id)} [data-focus="${key}"]:not(:disabled)`);
    if (target) target.focus({ preventScroll: true });
    else if (--tries > 0) window.requestAnimationFrame(attempt);
  };
  window.requestAnimationFrame(attempt);
}

// ---------------------------------------------------------------------------
// BulkProgress — "Approving 12 of 40…" → "38 approved · 2 failed  [Retry failed]"
// ---------------------------------------------------------------------------

function announcement(state: BulkRunState | null): string {
  if (!state) return "";
  if (state.phase === "running") return `${state.verbs.running} ${fmtInt(state.total)}…`;
  const r = state.result;
  return bulkSummaryText({ ok: r.ok.length, failed: r.failed.length, skipped: r.skipped.length }, state.verbs.done);
}

export interface BulkProgressProps {
  state: BulkRunState | null;
  /** Shows "Retry failed" (or "Resume" after a cancel) when something did not finish. */
  onRetry?: () => void;
  /** Shows Cancel while running. */
  onCancel?: () => void;
  /** Shows a dismiss (X) on the result. */
  onDismiss?: () => void;
  /** Dismiss a fully successful result after this many ms (default 6000; 0 = keep). */
  autoDismissMs?: number;
  /** Announce start and result politely (default true; the bar announces for itself). */
  announce?: boolean;
  className?: string;
}

/** Inline status of a bulk run. Renders nothing but its live region while idle. */
export function BulkProgress({
  state,
  onRetry,
  onCancel,
  onDismiss,
  autoDismissMs = 6000,
  announce = true,
  className,
}: BulkProgressProps) {
  const onDismissRef = React.useRef(onDismiss);
  React.useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  const done = state?.phase === "done" ? state : null;
  const clean = !!done && done.result.failed.length === 0 && done.result.skipped.length === 0;
  React.useEffect(() => {
    if (!clean || autoDismissMs <= 0) return;
    const t = window.setTimeout(() => onDismissRef.current?.(), autoDismissMs);
    return () => window.clearTimeout(t);
  }, [clean, autoDismissMs, done]);

  const live = announce ? (
    <span role="status" className="sr-only">
      {announcement(state)}
    </span>
  ) : null;

  if (!state) return live;

  if (state.phase === "running") {
    const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0;
    return (
      <div className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[13px]", className)}>
        {live}
        <span className="inline-flex min-w-0 items-center gap-2 text-foreground">
          <Loader2 size={14} className="shrink-0 animate-spin text-muted-foreground" aria-hidden />
          <span className="tabular-nums">{bulkProgressText(state.verbs.running, state.done, state.total)}</span>
        </span>
        <span
          role="progressbar"
          aria-label={`${state.verbs.running} progress`}
          aria-valuemin={0}
          aria-valuemax={state.total}
          aria-valuenow={state.done}
          className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-surface-muted"
        >
          <span
            className="block h-full rounded-full bg-accent transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${pct}%` }}
          />
        </span>
        {state.failed > 0 && <span className="tabular-nums text-danger-ink">{fmtInt(state.failed)} failed</span>}
        {onCancel && (
          <Button variant="ghost" size="toolbar" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    );
  }

  const { ok, failed, skipped } = state.result;
  const reasons = groupBulkErrors(failed);
  const top = reasons[0];
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[13px]", className)}>
      {live}
      <span className="inline-flex min-w-0 items-center gap-2">
        {failed.length > 0 || skipped.length > 0 ? (
          <AlertTriangle size={14} className="shrink-0 text-warning" aria-hidden />
        ) : (
          <CheckCircle2 size={14} className="shrink-0 text-success" aria-hidden />
        )}
        <span className="font-medium tabular-nums text-foreground">
          {bulkSummaryText({ ok: ok.length, failed: failed.length, skipped: skipped.length }, state.verbs.done)}
        </span>
      </span>
      {top &&
        (reasons.length > 1 ? (
          // Every reason reachable by keyboard, touch and screen reader, not only a hover tooltip.
          <details className="min-w-0 max-w-full text-muted-foreground">
            <summary
              className="cursor-pointer truncate rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              title={reasons.map((r) => `${r.error} (${fmtInt(r.count)})`).join("\n")}
            >
              {top.error}
              {top.count > 1 ? ` ×${fmtInt(top.count)}` : ""}
              {` · +${fmtInt(reasons.length - 1)} more`}
            </summary>
            <ul className="mt-1 space-y-0.5 break-words">
              {reasons.map((r) => (
                <li key={r.error}>
                  {r.error} <span className="tabular-nums">({fmtInt(r.count)})</span>
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <span className="min-w-0 max-w-full truncate text-muted-foreground" title={top.error}>
            {top.error}
            {top.count > 1 ? ` ×${fmtInt(top.count)}` : ""}
          </span>
        ))}
      {onRetry && (failed.length > 0 || skipped.length > 0) && (
        <Button variant="secondary" size="toolbar" onClick={onRetry}>
          <RotateCcw size={14} aria-hidden />
          {failed.length > 0 ? "Retry failed" : "Resume"}
        </Button>
      )}
      {onDismiss && (
        <IconButton aria-label="Dismiss result" title="Dismiss" size="sm" onClick={onDismiss}>
          <X size={14} aria-hidden />
        </IconButton>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BulkActionBar
// ---------------------------------------------------------------------------

export type BulkActionTone = "default" | "primary" | "danger";

export interface BulkAction {
  /** Stable key (default: the label). */
  key?: string;
  label: string;
  icon?: LucideIcon | React.ReactElement;
  /** default = secondary, primary = accent fill, danger = red outline. */
  tone?: BulkActionTone;
  onClick: () => void;
  disabled?: boolean;
  /** Spinner on this button (e.g. while its confirm dialog's request runs). */
  loading?: boolean;
  /** Tooltip, e.g. why the action is unavailable. */
  title?: string;
  hidden?: boolean;
}

const TONE_VARIANT: Record<BulkActionTone, ButtonVariant> = {
  default: "secondary",
  primary: "primary",
  danger: "danger-secondary",
};

export interface BulkActionBarProps {
  /** Selected rows. The bar shows while this is > 0 or `run` has a status. */
  count: number;
  onClear: () => void;
  actions?: BulkAction[];
  /** Extra controls before the actions (e.g. the "Confirm as" type select). */
  children?: React.ReactNode;
  /** A useBulkRun() handle: shows its progress / result and disables actions while it runs. */
  run?: Pick<BulkRun, "state" | "running" | "retryFailed" | "cancel" | "reset">;
  /** Disable every action (e.g. a request in flight that is not part of `run`). */
  busy?: boolean;
  /** Noun for the count: ["suggestion", "suggestions"] → "3 suggestions selected". */
  noun?: readonly [singular: string, plural: string];
  /** Accessible name of the region (default "Bulk actions"). */
  label?: string;
  /** Escape clears the selection (default true). */
  clearOnEscape?: boolean;
  /** Where focus goes when the bar closes while it holds focus (default: <main>). */
  returnFocus?: () => HTMLElement | null | undefined;
  /**
   * Limit Escape-to-clear to key presses inside this element (the bar's own
   * list). Use it when a page has more than one bar.
   */
  scopeRef?: React.RefObject<HTMLElement | null>;
  className?: string;
}

/** Text fields keep Escape for themselves; checkboxes and radios do not. */
const EDITABLE =
  'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), textarea, select, [contenteditable="true"]';

/**
 * Open bars' footprints: #main's bottom scroll-padding is the largest one, so
 * focus scrolling keeps controls out from under a bar (WCAG 2.4.11).
 */
const BAR_FOOTPRINTS = new Map<symbol, number>();
function applyBarPadding(scroller: HTMLElement) {
  scroller.style.scrollPaddingBottom = BAR_FOOTPRINTS.size ? `${Math.max(...BAR_FOOTPRINTS.values())}px` : "";
}

/**
 * The floating bar for a selection: "N selected", Clear, the actions and the
 * run's progress. Sticky at the bottom of the scrolling page area (see the
 * placement note at the top of this file); wraps on narrow screens.
 */
export function BulkActionBar({
  count,
  onClear,
  actions = [],
  children,
  run,
  busy = false,
  noun,
  label = "Bulk actions",
  clearOnEscape = true,
  returnFocus,
  scopeRef,
  className,
}: BulkActionBarProps) {
  const barRef = React.useRef<HTMLDivElement>(null);
  const focusInside = React.useRef(false);
  const onClearRef = React.useRef(onClear);
  const returnFocusRef = React.useRef(returnFocus);
  React.useEffect(() => {
    onClearRef.current = onClear;
    returnFocusRef.current = returnFocus;
  });

  const status = run?.state ?? null;
  const open = count > 0 || status !== null;
  const disabled = busy || !!run?.running;
  const nounText = noun ? (count === 1 ? noun[0] : noun[1]) : "";
  const selectedText = `${fmtInt(count)} ${nounText ? `${nounText} ` : ""}selected`;

  // "3 selected" → "" is silent to screen readers: say the selection went.
  const [prevCount, setPrevCount] = React.useState(count);
  const [cleared, setCleared] = React.useState(false);
  if (count !== prevCount) {
    setPrevCount(count);
    setCleared(prevCount > 0 && count === 0);
  }

  // Escape clears — unless a dialog or menu owns the key, the bar is not
  // rendered (a hidden pane), the key was pressed outside the bar's scope, or
  // the admin is typing in a field outside the bar.
  React.useEffect(() => {
    if (!clearOnEscape || count === 0) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]')) return;
      const bar = barRef.current;
      if (bar && bar.getClientRects().length === 0) return; // in a display:none pane
      const target = e.target instanceof Element ? e.target : null;
      const inBar = !!target && !!bar?.contains(target);
      const scope = scopeRef?.current;
      if (scope && !inBar && target && target !== document.body && !scope.contains(target)) return;
      if (!inBar && target?.closest(EDITABLE)) return;
      onClearRef.current();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [clearOnEscape, count, scopeRef]);

  // Alt+Shift+B jumps from anywhere to the bar (e.code: Option changes e.key on macOS).
  React.useEffect(() => {
    if (count === 0) return;
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.code !== "KeyB") return;
      const bar = barRef.current;
      if (!bar || bar.getClientRects().length === 0) return;
      const first = firstBarControl(bar);
      if (!first) return;
      e.preventDefault(); // with two bars open, only the first one responds
      first.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [count]);

  // Reserve the bar's height as #main's bottom scroll-padding while it is open,
  // so Tab / focus() scrolls the next row above the bar instead of under it.
  React.useEffect(() => {
    const bar = barRef.current;
    const scroller = document.getElementById("main");
    if (!open || !bar || !scroller) return;
    const id = Symbol();
    const measure = () => {
      BAR_FOOTPRINTS.set(id, bar.offsetHeight + 12 /* bottom-3 */ + 8 /* breathing room */);
      applyBarPadding(scroller);
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(bar);
    return () => {
      ro?.disconnect();
      BAR_FOOTPRINTS.delete(id);
      applyBarPadding(scroller);
    };
  }, [open]);

  // Closing while a bar button had focus would drop focus on <body>.
  React.useEffect(() => {
    if (open || !focusInside.current) return;
    focusInside.current = false;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const target = returnFocusRef.current?.() ?? document.getElementById("main");
    target?.focus({ preventScroll: true });
  }, [open]);

  const shown = actions.filter((a) => !a.hidden);

  return (
    <>
      {/* Always mounted, so the first "N selected" is announced too. */}
      <span role="status" className="sr-only">
        {count > 0 ? selectedText : cleared && !status ? "Selection cleared" : ""}
      </span>
      <span role="status" className="sr-only">
        {announcement(status)}
      </span>

      {open && (
        <div className={cn("pointer-events-none sticky bottom-3 z-20 mt-3 flex min-w-0 justify-center", className)}>
          <div
            ref={barRef}
            role="region"
            aria-label={label}
            data-bulk-bar=""
            aria-keyshortcuts={count > 0 ? "Alt+Shift+B" : undefined}
            onFocus={() => {
              focusInside.current = true;
            }}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focusInside.current = false;
            }}
            className="pointer-events-auto flex min-w-0 max-w-full flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface/95 py-2 pl-3 pr-2 shadow-soft-lg backdrop-blur motion-safe:animate-fadeUp"
          >
            {count > 0 && (
              <>
                <span className="inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap text-[13px] font-medium text-foreground">
                  <span
                    aria-hidden
                    className="grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[11px] font-semibold tabular-nums leading-none text-accent-foreground"
                  >
                    {fmtInt(count)}
                  </span>
                  <span>
                    <span className="sr-only">{fmtInt(count)} </span>
                    {nounText ? `${nounText} selected` : "selected"}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="toolbar"
                  onClick={onClear}
                  data-bar-clear=""
                  title="Clear selection (Esc) · Alt+Shift+B jumps here"
                  className="px-2.5 text-muted-foreground hover:text-foreground"
                >
                  <X size={14} aria-hidden />
                  Clear
                </Button>
                {(children || shown.length > 0) && <span aria-hidden className="h-5 w-px shrink-0 bg-border" />}
                {children}
                {shown.map((a) => {
                  const Icon = a.icon;
                  const icon =
                    a.loading || !Icon ? null : React.isValidElement(Icon) ? Icon : <Icon size={14} aria-hidden />;
                  return (
                    <Button
                      key={a.key ?? a.label}
                      variant={TONE_VARIANT[a.tone ?? "default"]}
                      size="toolbar"
                      onClick={a.onClick}
                      disabled={disabled || a.disabled}
                      loading={a.loading}
                      title={a.title}
                    >
                      {icon}
                      {a.label}
                    </Button>
                  );
                })}
              </>
            )}
            {status && (
              <div className={cn("min-w-0 max-w-full", count > 0 && "basis-full border-t border-border pt-2")}>
                <BulkProgress
                  state={status}
                  announce={false}
                  onRetry={run ? () => void run.retryFailed() : undefined}
                  onCancel={run?.cancel}
                  onDismiss={run?.reset}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
