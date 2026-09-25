import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BULK_MAX_IDS,
  HttpError,
  bulkErrorMessage,
  bulkProgressText,
  bulkSummaryText,
  chunk,
  groupBulkErrors,
  pruneSelection,
  requestJson,
  runBulk,
  runChunks,
  selectionInfo,
  setAllSelection,
  settleSelection,
  toggleSelection,
  type BulkProgress,
} from "@/lib/bulk";

/** A promise with its resolve/reject exposed. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks (lane hand-offs) run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id${i + 1}`);

// ---------------------------------------------------------------------------

describe("chunk", () => {
  it("splits into consecutive batches with a short last one", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  it("returns no batches for an empty list", () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it("defaults to the 200-id server limit", () => {
    const batches = chunk(ids(450));
    expect(BULK_MAX_IDS).toBe(200);
    expect(batches.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(batches.flat()).toEqual(ids(450));
  });

  it("rejects a size that is not a positive integer", () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
    expect(() => chunk([1], -1)).toThrow(RangeError);
    expect(() => chunk([1], 1.5)).toThrow(RangeError);
    expect(() => chunk([1], Number.NaN)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------

describe("runBulk", () => {
  it("never runs more than `concurrency` workers at once and keeps input order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    const worker = async (id: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const g = deferred<void>();
      gates.set(id, g);
      await g.promise;
      inFlight--;
    };

    const run = runBulk(ids(6), worker, { concurrency: 2 });
    await flush();
    expect(inFlight).toBe(2);
    // Finish out of order: results still come back in input order.
    for (const id of ["id2", "id1", "id4", "id3", "id6", "id5"]) {
      while (!gates.has(id)) await flush();
      gates.get(id)!.resolve();
      await flush();
    }
    const res = await run;
    expect(maxInFlight).toBe(2);
    expect(res).toEqual({ ok: ids(6), failed: [], skipped: [], aborted: false });
  });

  it("defaults to 4 in flight and never more than the item count", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const worker = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await flush();
      inFlight--;
    };
    await runBulk(ids(10), worker);
    expect(maxInFlight).toBe(4);

    maxInFlight = 0;
    await runBulk(ids(2), worker, { concurrency: 8 });
    expect(maxInFlight).toBe(2);
  });

  it("treats an invalid concurrency as 1", async () => {
    for (const concurrency of [0, -3, Number.NaN]) {
      let inFlight = 0;
      let maxInFlight = 0;
      const res = await runBulk(
        ids(3),
        async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await flush();
          inFlight--;
        },
        { concurrency }
      );
      expect(maxInFlight).toBe(1);
      expect(res.ok).toEqual(ids(3));
    }
  });

  it("collects failures (thrown or rejected, any value) and never throws", async () => {
    const res = await runBulk(ids(6), (id) => {
      if (id === "id2") throw new Error("boom"); // synchronous throw
      if (id === "id3") return Promise.reject("plain string");
      if (id === "id4") return Promise.reject({ error: "Not reprocessable" });
      if (id === "id5") return Promise.reject(new HttpError("Gone", 410, { error: "Gone" }));
      return Promise.resolve();
    });
    expect(res.ok).toEqual(["id1", "id6"]);
    expect(res.failed).toEqual([
      { id: "id2", error: "boom" },
      { id: "id3", error: "plain string" },
      { id: "id4", error: "Not reprocessable" },
      { id: "id5", error: "Gone", status: 410 },
    ]);
    expect(res.skipped).toEqual([]);
    expect(res.aborted).toBe(false);
  });

  it("reports progress after every item, even when the callback throws", async () => {
    const events: BulkProgress<string>[] = [];
    const res = await runBulk(
      ids(3),
      async (id) => {
        if (id === "id2") throw new Error("nope");
      },
      {
        concurrency: 1,
        onProgress: (p) => {
          events.push(p);
          throw new Error("progress callback bug");
        },
      }
    );
    expect(res.ok).toEqual(["id1", "id3"]);
    expect(events.map((e) => [e.done, e.ok, e.failed, e.total])).toEqual([
      [1, 1, 0, 3],
      [2, 1, 1, 3],
      [3, 2, 1, 3],
    ]);
    expect(events[1].settled).toEqual([{ id: "id2", error: "nope" }]);
  });

  it("stops starting items on abort; in-flight items settle, the rest are skipped", async () => {
    const ctrl = new AbortController();
    const started: string[] = [];
    const res = await runBulk(
      ids(5),
      async (id) => {
        started.push(id);
        await flush();
        if (id === "id2") ctrl.abort();
      },
      { concurrency: 1, signal: ctrl.signal }
    );
    expect(started).toEqual(["id1", "id2"]);
    expect(res).toEqual({ ok: ["id1", "id2"], failed: [], skipped: ["id3", "id4", "id5"], aborted: true });
  });

  it("counts an AbortError after cancel as skipped, not failed", async () => {
    const ctrl = new AbortController();
    const res = await runBulk(
      ids(2),
      async (id, _i, signal) => {
        if (id === "id1") {
          ctrl.abort();
          expect(signal).toBe(ctrl.signal);
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          throw err;
        }
      },
      { concurrency: 1, signal: ctrl.signal }
    );
    expect(res).toEqual({ ok: [], failed: [], skipped: ["id1", "id2"], aborted: true });
  });

  it("does nothing when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const worker = vi.fn();
    const res = await runBulk(ids(3), worker, { signal: ctrl.signal });
    expect(worker).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: [], failed: [], skipped: ids(3), aborted: true });
  });

  it("handles an empty list", async () => {
    const worker = vi.fn();
    expect(await runBulk([], worker)).toEqual({ ok: [], failed: [], skipped: [], aborted: false });
    expect(worker).not.toHaveBeenCalled();
  });

  it("reports ids from getId for object items", async () => {
    const rows = [{ id: "a" }, { id: "b" }];
    const res = await runBulk(
      rows,
      async (row) => {
        if (row.id === "b") throw new Error("bad");
      },
      { getId: (row) => row.id }
    );
    expect(res.ok).toEqual(["a"]);
    expect(res.failed).toEqual([{ id: "b", error: "bad" }]);
  });
});

// ---------------------------------------------------------------------------

describe("runChunks", () => {
  it("sends deduped ids in sequential batches; void means every id succeeded", async () => {
    const batches: string[][] = [];
    let inFlight = 0;
    const res = await runChunks(
      [...ids(5), "id1", "id3"],
      async (batch) => {
        inFlight++;
        expect(inFlight).toBe(1);
        batches.push(batch);
        await flush();
        inFlight--;
      },
      { size: 2 }
    );
    expect(batches).toEqual([["id1", "id2"], ["id3", "id4"], ["id5"]]);
    expect(res).toEqual({ ok: ids(5), failed: [], skipped: [], aborted: false });
  });

  it("uses 200 ids per request by default", async () => {
    const sizes: number[] = [];
    await runChunks(ids(401), async (batch) => {
      sizes.push(batch.length);
    });
    expect(sizes).toEqual([200, 200, 1]);
  });

  it("fails ids missing from an `ok` list", async () => {
    const res = await runChunks(ids(3), async (batch) => ({ ok: batch.filter((id) => id !== "id2") }));
    expect(res.ok).toEqual(["id1", "id3"]);
    expect(res.failed).toEqual([{ id: "id2", error: "Not found or already changed" }]);

    const custom = await runChunks(["x"], async () => ({ ok: [] }), { missingError: "Not in this org" });
    expect(custom.failed).toEqual([{ id: "x", error: "Not in this org" }]);
  });

  it("takes per-id failures from the server; the rest succeed", async () => {
    const res = await runChunks(ids(3), async () => ({
      failed: [
        { id: "id3", error: "Already reviewed", status: 409 },
        { id: "other", error: "not in this batch" },
      ],
    }));
    expect(res.ok).toEqual(["id1", "id2"]);
    expect(res.failed).toEqual([{ id: "id3", error: "Already reviewed", status: 409 }]);
  });

  it("fails the whole batch when the request throws, then carries on", async () => {
    let call = 0;
    const res = await runChunks(
      ids(4),
      async () => {
        call++;
        if (call === 1) throw new HttpError("Forbidden", 403, { error: "Forbidden" });
      },
      { size: 2 }
    );
    expect(res.failed).toEqual([
      { id: "id1", error: "Forbidden", status: 403 },
      { id: "id2", error: "Forbidden", status: 403 },
    ]);
    expect(res.ok).toEqual(["id3", "id4"]);
  });

  it("resends `remaining` ids (server time budget) until done", async () => {
    const batches: string[][] = [];
    const res = await runChunks(ids(4), async (batch) => {
      batches.push(batch);
      // Process only the first id of each request.
      return { ok: batch.slice(0, 1), remaining: batch.slice(1) };
    });
    expect(batches).toEqual([ids(4), ["id2", "id3", "id4"], ["id3", "id4"], ["id4"]]);
    expect(res.ok).toEqual(ids(4));
    expect(res.failed).toEqual([]);
  });

  it("fails `remaining` ids when a request makes no progress (no endless loop)", async () => {
    const send = vi.fn(async (batch: string[]) => ({ remaining: batch }));
    const res = await runChunks(ids(2), send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(res.ok).toEqual([]);
    expect(res.failed.map((f) => f.id)).toEqual(ids(2));
  });

  it("treats a raw `{ ok: true }` body as all succeeded", async () => {
    const res = await runChunks(ids(2), async () => ({ ok: true, updated: 2 }) as never);
    expect(res.ok).toEqual(ids(2));
    expect(res.failed).toEqual([]);
  });

  it("skips the remaining batches after abort", async () => {
    const ctrl = new AbortController();
    const send = vi.fn(async () => {
      ctrl.abort();
    });
    const res = await runChunks(ids(5), send, { size: 2, signal: ctrl.signal });
    expect(send).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: ["id1", "id2"], failed: [], skipped: ["id3", "id4", "id5"], aborted: true });
  });

  it("reports progress per batch", async () => {
    const events: BulkProgress<string>[] = [];
    await runChunks(ids(3), async (batch) => ({ ok: batch.filter((id) => id !== "id3") }), {
      size: 2,
      onProgress: (p) => events.push(p),
    });
    expect(events.map((e) => [e.done, e.ok, e.failed, e.total])).toEqual([
      [2, 2, 0, 3],
      [3, 2, 1, 3],
    ]);
    expect(events[1].settled).toEqual([{ id: "id3", error: "Not found or already changed" }]);
  });
});

// ---------------------------------------------------------------------------

describe("requestJson", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a JSON body and returns the parsed response", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, ids: ["a"] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await requestJson<{ ids: string[] }>("/api/x", { method: "PATCH", json: { ids: ["a"] } });
    expect(out.ids).toEqual(["a"]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/x");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ ids: ["a"] }));
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  });

  it("throws HttpError with the server's error message and status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Source text not recoverable" }), { status: 422 }))
    );
    const err = await requestJson("/api/x", { method: "POST" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(422);
    expect((err as HttpError).message).toBe("Source text not recoverable");
  });

  it("falls back to the status when the error body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>oops</html>", { status: 504 })));
    const err = await requestJson("/api/x").catch((e: unknown) => e);
    expect((err as HttpError).message).toBe("Request failed (504)");
    expect((err as HttpError).status).toBe(504);
  });

  it("resolves null for an empty body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    expect(await requestJson("/api/x", { method: "DELETE" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("bulk copy", () => {
  it("formats the progress line", () => {
    expect(bulkProgressText("Approving", 12, 40)).toBe("Approving 12 of 40…");
    expect(bulkProgressText("Reprocessing", 1200, 1500)).toBe("Reprocessing 1,200 of 1,500…");
  });

  it("formats the result summary", () => {
    expect(bulkSummaryText({ ok: 38, failed: 2 }, "approved")).toBe("38 approved · 2 failed");
    expect(bulkSummaryText({ ok: 40, failed: 0 }, "approved")).toBe("40 approved");
    expect(bulkSummaryText({ ok: 0, failed: 2 }, "approved")).toBe("2 failed");
    expect(bulkSummaryText({ ok: 12, failed: 0, skipped: 28 }, "approved")).toBe("12 approved · 28 cancelled");
    expect(bulkSummaryText({ ok: 0, failed: 0 }, "approved")).toBe("0 approved");
  });

  it("groups failure reasons, most common first", () => {
    expect(
      groupBulkErrors([
        { id: "a", error: "Timeout" },
        { id: "b", error: "Not found" },
        { id: "c", error: "Not found" },
      ])
    ).toEqual([
      { error: "Not found", count: 2 },
      { error: "Timeout", count: 1 },
    ]);
  });

  it("extracts a message from anything thrown", () => {
    expect(bulkErrorMessage(new Error("x"))).toBe("x");
    expect(bulkErrorMessage({ error: "y" })).toBe("y");
    expect(bulkErrorMessage({ message: "z" })).toBe("z");
    expect(bulkErrorMessage(42)).toBe("Failed");
    expect(bulkErrorMessage(new Error(""), "Fallback")).toBe("Fallback");
  });
});

// ---------------------------------------------------------------------------

describe("selection reducers", () => {
  const order = ["a", "b", "c", "d", "e"];

  it("toggles one row on and off", () => {
    const on = toggleSelection(new Set(), "b", { order });
    expect([...on]).toEqual(["b"]);
    expect([...toggleSelection(on, "b", { order })]).toEqual([]);
  });

  it("shift-selects the range from the anchor, in either direction", () => {
    expect([...toggleSelection(new Set(["b"]), "d", { anchor: "b", order })].sort()).toEqual(["b", "c", "d"]);
    expect([...toggleSelection(new Set(["d"]), "a", { anchor: "d", order })].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("shift-deselects a range when the clicked row was selected", () => {
    const all = new Set(order);
    expect([...toggleSelection(all, "d", { anchor: "b", order })].sort()).toEqual(["a", "e"]);
  });

  it("falls back to a single toggle when the anchor is gone or the same row", () => {
    expect([...toggleSelection(new Set(), "c", { anchor: "zzz", order })]).toEqual(["c"]);
    expect([...toggleSelection(new Set(), "c", { anchor: "c", order })]).toEqual(["c"]);
    expect([...toggleSelection(new Set(), "c", { anchor: null, order })]).toEqual(["c"]);
  });

  it("honours an explicit target state", () => {
    expect([...toggleSelection(new Set(["c"]), "c", { checked: true })]).toEqual(["c"]);
    expect([...toggleSelection(new Set(), "c", { checked: false })]).toEqual([]);
  });

  it("does not mutate the previous set", () => {
    const prev = new Set(["a"]);
    toggleSelection(prev, "b", { order });
    expect([...prev]).toEqual(["a"]);
  });

  it("prunes ids that left the visible list", () => {
    const prev = new Set(["a", "c", "x"]);
    const next = pruneSelection(prev, order);
    expect([...next].sort()).toEqual(["a", "c"]);
    expect(next).not.toBe(prev);
    expect(pruneSelection(new Set(["a"]), new Set(["b"])).size).toBe(0);
  });

  it("returns the same set when nothing needs pruning (no re-render)", () => {
    const prev = new Set(["a", "c"]);
    expect(pruneSelection(prev, order)).toBe(prev);
    const empty = new Set<string>();
    expect(pruneSelection(empty, [])).toBe(empty);
  });

  it("settles a bulk run: unticks what succeeded, keeps failed + cancelled, leaves rows ticked meanwhile", () => {
    // The run acted on a, b, c, d; while it ran the admin ticked x and unticked e.
    const now = new Set(["a", "b", "c", "d", "x"]);
    const next = settleSelection(now, { ok: ["a", "b"], failed: [{ id: "c", error: "boom" }], skipped: ["d"] });
    expect([...next].sort()).toEqual(["c", "d", "x"]);
    // A failed row the admin unticked mid-run comes back (it still needs doing).
    expect([...settleSelection(new Set(["x"]), { ok: [], failed: [{ id: "c", error: "boom" }], skipped: [] })].sort()).toEqual(["c", "x"]);
    expect([...now].sort()).toEqual(["a", "b", "c", "d", "x"]); // not mutated
  });

  it("returns the same set when settling changes nothing (no re-render)", () => {
    const prev = new Set(["c", "x"]);
    expect(settleSelection(prev, { ok: ["a"], failed: [{ id: "c", error: "boom" }], skipped: [] })).toBe(prev);
  });

  it("selects all visible rows or none", () => {
    expect([...setAllSelection(order, true)]).toEqual(order);
    expect(setAllSelection(order, false).size).toBe(0);
  });

  it("derives count / all / some in on-screen order", () => {
    expect(selectionInfo(new Set(), order)).toEqual({
      selectedIds: [],
      count: 0,
      allSelected: false,
      someSelected: false,
    });
    expect(selectionInfo(new Set(["d", "a"]), order)).toEqual({
      selectedIds: ["a", "d"],
      count: 2,
      allSelected: false,
      someSelected: true,
    });
    expect(selectionInfo(new Set(order), order)).toMatchObject({ count: 5, allSelected: true, someSelected: false });
    // Selected ids that are not visible do not count; an empty list is never "all selected".
    expect(selectionInfo(new Set(["x"]), [])).toMatchObject({ count: 0, allSelected: false, someSelected: false });
  });
});
