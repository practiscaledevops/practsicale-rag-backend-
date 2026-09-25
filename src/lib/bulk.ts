// Bulk actions for the back office: select many rows, then approve / reject /
// reprocess / delete them in one go. Pure, framework-free helpers (safe in
// tests and on either side); the React hooks and the bar live in
// src/components/ui/Bulk.tsx.
//
// Two ways to act on many rows:
//
//   runChunks(ids, send)          ONE request per ≤200 ids to a server bulk
//                                 endpoint. Use it for set-based DB updates
//                                 (confirm, reject, approve, archive, pause,
//                                 delete).
//   runBulk(items, worker, opts)  A bounded pool over a SINGLE-item endpoint,
//                                 for heavy per-item work (LLM compile,
//                                 re-embed, source sync). Never bundle that
//                                 into one request: Vercel functions time out.
//
// Neither ever throws: every item ends up in `ok`, `failed` (with the error
// message) or `skipped` (cancelled before it ran).

import { fmtInt } from "./format";

/** Most ids a server bulk endpoint accepts per request (keeps PostgREST URLs short). */
export const BULK_MAX_IDS = 200;

/**
 * Suggested pool sizes for runBulk. `db` for cheap per-item requests,
 * `reingest` for LLM contextualize + embed (~60s each), `sync` / `llm` for
 * source pulls and model compiles that run close to the function limit.
 */
export const BULK_CONCURRENCY = { db: 4, reingest: 2, sync: 1, llm: 1 } as const;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface BulkFailure<K = string> {
  id: K;
  error: string;
  /** HTTP status when the failure came from requestJson (e.g. 422 = not reprocessable). */
  status?: number;
}

export interface BulkResult<K = string> {
  /** Items that succeeded, in input order (runBulk) or processing order (runChunks). */
  ok: K[];
  failed: BulkFailure<K>[];
  /** Items never attempted (or aborted mid-request) because the run was cancelled. */
  skipped: K[];
  /** The signal was aborted before the run finished. */
  aborted: boolean;
}

export interface BulkSettled<K = string> {
  id: K;
  /** Present when the item failed. */
  error?: string;
}

export interface BulkProgress<K = string> {
  /** Items finished so far (ok + failed). */
  done: number;
  total: number;
  ok: number;
  failed: number;
  /** The items that finished in this step. */
  settled: BulkSettled<K>[];
}

/** A non-2xx response from requestJson, carrying the status and parsed body. */
export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

/** A readable message for anything thrown (Error, string, `{ error }` body). */
export function bulkErrorMessage(e: unknown, fallback = "Failed"): string {
  if (e instanceof Error) return e.message || fallback;
  if (typeof e === "string") return e || fallback;
  if (e && typeof e === "object") {
    const o = e as { error?: unknown; message?: unknown };
    if (typeof o.error === "string" && o.error) return o.error;
    if (typeof o.message === "string" && o.message) return o.message;
  }
  return fallback;
}

function statusOf(e: unknown): number | undefined {
  if (e instanceof HttpError) return e.status;
  if (e && typeof e === "object" && typeof (e as { status?: unknown }).status === "number") {
    return (e as { status: number }).status;
  }
  return undefined;
}

function isAbortError(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: unknown }).name === "AbortError";
}

function failure<K>(id: K, e: unknown): BulkFailure<K> {
  const status = statusOf(e);
  return status === undefined ? { id, error: bulkErrorMessage(e) } : { id, error: bulkErrorMessage(e), status };
}

function safeCall<A>(fn: ((arg: A) => void) | undefined, arg: A): void {
  if (!fn) return;
  try {
    fn(arg);
  } catch {
    /* a throwing progress callback must not break the run */
  }
}

function unique<K>(ids: readonly K[]): K[] {
  return Array.from(new Set(ids));
}

// ---------------------------------------------------------------------------
// chunk
// ---------------------------------------------------------------------------

/** Split `items` into consecutive batches of at most `size` (default 200). */
export function chunk<T>(items: readonly T[], size: number = BULK_MAX_IDS): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`chunk size must be a positive integer (got ${String(size)})`);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// runBulk — bounded pool over a single-item operation
// ---------------------------------------------------------------------------

export type BulkWorker<T> = (item: T, index: number, signal: AbortSignal | undefined) => unknown;

export interface RunBulkOptions<T, K> {
  /** Items in flight at once (default 4, minimum 1). See BULK_CONCURRENCY. */
  concurrency?: number;
  /** Abort: no new item starts; in-flight items settle (the worker gets the signal). */
  signal?: AbortSignal;
  onProgress?: (progress: BulkProgress<K>) => void;
  /** The id reported for an item (default: the item itself). */
  getId?: (item: T, index: number) => K;
}

function poolSize(concurrency: number | undefined, total: number): number {
  const n = Math.floor(Number(concurrency ?? 4));
  const limit = Number.isFinite(n) && n >= 1 ? n : 1;
  return Math.max(1, Math.min(limit, total));
}

/**
 * Run `worker` over every item with at most `concurrency` in flight. A worker
 * fails by throwing (or rejecting). Never throws itself.
 *
 *   const res = await runBulk(ids, (id, _i, signal) =>
 *     requestJson(`/api/admin/documents/${id}/reingest`, { method: "POST", signal }),
 *     { concurrency: BULK_CONCURRENCY.reingest });
 */
export async function runBulk<T, K = T>(
  items: readonly T[],
  worker: BulkWorker<T>,
  opts: RunBulkOptions<T, K> = {}
): Promise<BulkResult<K>> {
  const { signal, onProgress, getId } = opts;
  const total = items.length;
  const ids: K[] = items.map((item, i) => {
    if (!getId) return item as unknown as K;
    try {
      return getId(item, i);
    } catch {
      return item as unknown as K;
    }
  });
  // Per-index outcome, so results come back in input order.
  const outcome: (true | "skipped" | BulkFailure<K> | undefined)[] = new Array(total);
  let next = 0;
  let okCount = 0;
  let failCount = 0;

  async function lane(): Promise<void> {
    for (;;) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= total) return;
      let settled: BulkSettled<K>;
      try {
        await worker(items[i], i, signal);
        outcome[i] = true;
        okCount++;
        settled = { id: ids[i] };
      } catch (e) {
        if (signal?.aborted && isAbortError(e)) {
          outcome[i] = "skipped";
          continue;
        }
        const f = failure(ids[i], e);
        outcome[i] = f;
        failCount++;
        settled = { id: ids[i], error: f.error };
      }
      safeCall(onProgress, { done: okCount + failCount, total, ok: okCount, failed: failCount, settled: [settled] });
    }
  }

  if (total > 0 && !signal?.aborted) {
    await Promise.all(Array.from({ length: poolSize(opts.concurrency, total) }, () => lane()));
  }

  const result: BulkResult<K> = { ok: [], failed: [], skipped: [], aborted: !!signal?.aborted };
  for (let i = 0; i < total; i++) {
    const o = outcome[i];
    if (o === true) result.ok.push(ids[i]);
    else if (o && o !== "skipped") result.failed.push(o);
    else result.skipped.push(ids[i]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// runChunks — ≤200 ids per request to a server bulk endpoint
// ---------------------------------------------------------------------------

/**
 * What one bulk request reports back (all optional):
 *  - nothing / void         every id in the batch succeeded;
 *  - `failed`               these ids failed (the rest succeeded, unless `ok` is given);
 *  - `ok`                   only these ids succeeded; the other ids in the batch
 *                           failed with `missingError` (e.g. not found in this org);
 *  - `remaining`            the server ran out of its time budget: these ids are
 *                           sent again in the next request.
 * Map the server's JSON to this shape; a raw `{ ok: true }` body counts as void.
 */
export interface ChunkOutcome<K = string> {
  ok?: readonly K[];
  failed?: readonly BulkFailure<K>[];
  remaining?: readonly K[];
}

export type ChunkSender<K> = (batch: K[], signal: AbortSignal | undefined) => Promise<ChunkOutcome<K> | void>;

export interface RunChunksOptions<K> {
  /** Ids per request (default 200, the server limit). */
  size?: number;
  signal?: AbortSignal;
  onProgress?: (progress: BulkProgress<K>) => void;
  /** Error for ids missing from an `ok` list (default "Not found or already changed"). */
  missingError?: string;
}

const MISSING_ERROR = "Not found or already changed";
const STALLED_ERROR = "The server made no progress on these items. Try again.";

/**
 * Send `ids` (deduped) to a server bulk endpoint in sequential batches of
 * `size`. A batch that throws fails as a whole. Never throws.
 *
 *   await runChunks(ids, async (batch, signal) => {
 *     const r = await requestJson<{ ids: string[] }>("/api/admin/knowledge/relationships",
 *       { method: "PATCH", json: { ids: batch, action: "confirm" }, signal });
 *     return { ok: r.ids };
 *   });
 */
export async function runChunks<K = string>(
  ids: readonly K[],
  send: ChunkSender<K>,
  opts: RunChunksOptions<K> = {}
): Promise<BulkResult<K>> {
  const { signal, onProgress } = opts;
  const size = opts.size ?? BULK_MAX_IDS;
  const safeSize = Number.isInteger(size) && size >= 1 ? size : BULK_MAX_IDS;
  const missingError = opts.missingError ?? MISSING_ERROR;
  const queue = unique(ids);
  const total = queue.length;
  const result: BulkResult<K> = { ok: [], failed: [], skipped: [], aborted: false };

  const report = (settled: BulkSettled<K>[]) =>
    safeCall(onProgress, {
      done: result.ok.length + result.failed.length,
      total,
      ok: result.ok.length,
      failed: result.failed.length,
      settled,
    });

  while (queue.length > 0) {
    if (signal?.aborted) {
      result.skipped.push(...queue.splice(0));
      break;
    }
    const batch = queue.splice(0, safeSize);
    let out: ChunkOutcome<K> | void;
    try {
      out = await send(batch, signal);
    } catch (e) {
      if (signal?.aborted && isAbortError(e)) {
        result.skipped.push(...batch);
        continue;
      }
      const settled: BulkSettled<K>[] = [];
      for (const id of batch) {
        const f = failure(id, e);
        result.failed.push(f);
        settled.push({ id, error: f.error });
      }
      report(settled);
      continue;
    }

    const inBatch = new Set(batch);
    const o = out && typeof out === "object" ? out : undefined;
    const failedById = new Map<K, BulkFailure<K>>();
    if (o && Array.isArray(o.failed)) {
      for (const f of o.failed) {
        if (!f || !inBatch.has(f.id) || failedById.has(f.id)) continue;
        const entry: BulkFailure<K> = { id: f.id, error: bulkErrorMessage(f.error) };
        if (typeof f.status === "number") entry.status = f.status;
        failedById.set(f.id, entry);
      }
    }
    const remaining = new Set(
      o && Array.isArray(o.remaining) ? o.remaining.filter((id) => inBatch.has(id) && !failedById.has(id)) : []
    );
    const okList = o && Array.isArray(o.ok) ? new Set(o.ok) : null;
    const stalled = remaining.size > 0 && remaining.size === batch.length;

    const settled: BulkSettled<K>[] = [];
    const requeue: K[] = [];
    for (const id of batch) {
      const f = failedById.get(id);
      if (f) {
        result.failed.push(f);
        settled.push({ id, error: f.error });
      } else if (remaining.has(id)) {
        if (stalled) {
          result.failed.push({ id, error: STALLED_ERROR });
          settled.push({ id, error: STALLED_ERROR });
        } else {
          requeue.push(id);
        }
      } else if (okList === null || okList.has(id)) {
        result.ok.push(id);
        settled.push({ id });
      } else {
        result.failed.push({ id, error: missingError });
        settled.push({ id, error: missingError });
      }
    }
    queue.unshift(...requeue);
    report(settled);
  }

  result.aborted = !!signal?.aborted;
  return result;
}

// ---------------------------------------------------------------------------
// requestJson — fetch that throws HttpError with the server's { error }
// ---------------------------------------------------------------------------

export interface RequestJsonInit extends RequestInit {
  /** Sent as the JSON body (sets content-type). */
  json?: unknown;
}

/**
 * fetch + JSON with the status kept on failure, so a bulk worker can tell a
 * 422 ("not reprocessable") from a 500. Resolves to the parsed body (null for
 * an empty one); throws HttpError(body.error ?? "Request failed (status)").
 */
export async function requestJson<T = unknown>(url: string, init: RequestJsonInit = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const h = new Headers(headers);
  if (json !== undefined && !h.has("content-type")) h.set("content-type", "application/json");
  const res = await fetch(url, {
    cache: "no-store",
    ...rest,
    headers: h,
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const fromBody = body && typeof body === "object" ? bulkErrorMessage(body, "") : "";
    throw new HttpError(fromBody || `Request failed (${res.status})`, res.status, body);
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Copy for the progress line / result summary
// ---------------------------------------------------------------------------

/** Verb pair for one bulk action: `{ running: "Approving", done: "approved" }`. */
export interface BulkVerbs {
  running: string;
  done: string;
}

export const DEFAULT_BULK_VERBS: BulkVerbs = { running: "Processing", done: "done" };

/** "Approving 12 of 40…" */
export function bulkProgressText(verb: string, done: number, total: number): string {
  return `${verb} ${fmtInt(done)} of ${fmtInt(total)}…`;
}

/** "38 approved · 2 failed", "40 approved", "2 failed", "12 approved · 28 cancelled". */
export function bulkSummaryText(
  counts: { ok: number; failed: number; skipped?: number },
  doneVerb: string
): string {
  const skipped = counts.skipped ?? 0;
  const parts: string[] = [];
  if (counts.ok > 0 || (counts.failed === 0 && skipped === 0)) parts.push(`${fmtInt(counts.ok)} ${doneVerb}`);
  if (counts.failed > 0) parts.push(`${fmtInt(counts.failed)} failed`);
  if (skipped > 0) parts.push(`${fmtInt(skipped)} cancelled`);
  return parts.join(" · ");
}

/** Failure reasons with counts, most common first ("Not found" ×3). */
export function groupBulkErrors<K>(failed: readonly BulkFailure<K>[]): { error: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const f of failed) counts.set(f.error, (counts.get(f.error) ?? 0) + 1);
  return Array.from(counts, ([error, count]) => ({ error, count })).sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Selection reducers (pure; useSelection in components/ui/Bulk.tsx wraps them)
// ---------------------------------------------------------------------------

/**
 * Toggle `id`. With an `anchor` (the last row toggled) and the on-screen
 * `order`, every row between the two gets the clicked row's new state
 * (shift-click range). An anchor that is not in `order` falls back to `id` alone.
 * `checked` forces the new state (default: the opposite of the row's current one).
 */
export function toggleSelection(
  prev: ReadonlySet<string>,
  id: string,
  opts: { anchor?: string | null; order?: readonly string[]; checked?: boolean } = {}
): Set<string> {
  const next = new Set(prev);
  const checked = opts.checked ?? !prev.has(id);
  const order = opts.order ?? [];
  const from = opts.anchor ? order.indexOf(opts.anchor) : -1;
  const to = order.indexOf(id);
  const range =
    from >= 0 && to >= 0 && from !== to ? order.slice(Math.min(from, to), Math.max(from, to) + 1) : [id];
  for (const rid of range) {
    if (checked) next.add(rid);
    else next.delete(rid);
  }
  return next;
}

/** Drop selected ids that are no longer visible. Returns `prev` itself when nothing changed. */
export function pruneSelection(
  prev: ReadonlySet<string>,
  visible: readonly string[] | ReadonlySet<string>
): ReadonlySet<string> {
  if (prev.size === 0) return prev;
  const vis: ReadonlySet<string> = visible instanceof Set ? visible : new Set(visible as readonly string[]);
  for (const id of prev) {
    if (!vis.has(id)) return new Set(Array.from(prev).filter((x) => vis.has(x)));
  }
  return prev;
}

/**
 * The selection after a bulk run: ids that succeeded leave it, failed and
 * skipped (cancelled) ids stay (or come back), and every other id is left as
 * it is now, so rows ticked or unticked while the run was going are kept.
 * Returns `prev` itself when nothing changed.
 */
export function settleSelection(
  prev: ReadonlySet<string>,
  result: Pick<BulkResult<string>, "ok" | "failed" | "skipped">
): ReadonlySet<string> {
  const next = new Set(prev);
  for (const id of result.ok) next.delete(id);
  for (const f of result.failed) next.add(f.id);
  for (const id of result.skipped) next.add(id);
  if (next.size === prev.size && Array.from(next).every((id) => prev.has(id))) return prev;
  return next;
}

/** Select every visible row (`on`) or none. */
export function setAllSelection(visible: readonly string[], on: boolean): Set<string> {
  return on ? new Set(visible) : new Set();
}

export interface SelectionInfo {
  /** Selected ids in on-screen order. */
  selectedIds: string[];
  count: number;
  /** Every visible row is selected (false when there are none). */
  allSelected: boolean;
  /** Some, but not all, visible rows are selected (the header's mixed state). */
  someSelected: boolean;
}

export function selectionInfo(selected: ReadonlySet<string>, visible: readonly string[]): SelectionInfo {
  const selectedIds = selected.size === 0 ? [] : visible.filter((id) => selected.has(id));
  const count = selectedIds.length;
  const allSelected = visible.length > 0 && count === visible.length;
  return { selectedIds, count, allSelected, someSelected: count > 0 && !allSelected };
}
