import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerFailure, withModelRequest } from "@/lib/model-runtime";
import { rerank, RERANK_TIME_LIMIT_MS } from "@/lib/rerank";

const m = vi.hoisted(() => ({ key: vi.fn(), llm: vi.fn() }));
vi.mock("@/lib/secrets", () => ({ getProviderKey: m.key }));
vi.mock("@/lib/llm-rerank", () => ({ llmRerank: m.llm }));

const hits = ["policy-a", "policy-b", "policy-c"].map((id, i) => ({
  id, document_id: "handbook", parent_id: null, content: `Policy fact ${i + 1}`, metadata: {},
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  m.key.mockResolvedValue("local-test-key");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("reranking deadline", () => {
  it("keeps a fast provider's ordering and scores", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      results: [{ index: 2, relevance_score: 0.95 }, { index: 0, relevance_score: 0.81 }],
    })));
    const timedOut = vi.fn();
    expect(await rerank("What does the policy say?", hits, 2, timedOut)).toEqual([
      { ...hits[2], score: 0.95 }, { ...hits[0], score: 0.81 },
    ]);
    expect(timedOut).not.toHaveBeenCalled();
    expect(m.llm).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a slow cross-encoder and returns the same search facts and IDs at the limit", async () => {
    let providerSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, options?: RequestInit) => {
      providerSignal = options?.signal;
      return new Promise<Response>(() => {});
    }));
    const timedOut = vi.fn();
    const answer = rerank("What does the policy say?", hits, 2, timedOut);
    await vi.advanceTimersByTimeAsync(RERANK_TIME_LIMIT_MS - 1);
    expect(timedOut).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await answer).toEqual(hits.slice(0, 2));
    expect(providerSignal?.aborted).toBe(true);
    expect(timedOut).toHaveBeenCalledTimes(1);
    expect(m.llm).not.toHaveBeenCalled();
  });

  it("shares the deadline across both providers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 900));
      return new Response(null, { status: 503 });
    }));
    m.llm.mockImplementation(() => new Promise(() => {}));
    const answer = rerank("What does the policy say?", hits, 2);
    await vi.advanceTimersByTimeAsync(900);
    expect(m.llm).toHaveBeenCalledTimes(1);
    const signal = m.llm.mock.calls[0][4] as AbortSignal;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(RERANK_TIME_LIMIT_MS - 900);
    expect(await answer).toEqual(hits.slice(0, 2));
    expect(signal.aborted).toBe(true);
  });

  it("does not start a provider after a late secrets lookup", async () => {
    let release!: (value: string) => void;
    m.key.mockReturnValueOnce(new Promise<string>(resolve => { release = resolve; }));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const answer = rerank("What does the policy say?", hits, 2);
    await vi.advanceTimersByTimeAsync(RERANK_TIME_LIMIT_MS);
    expect(await answer).toEqual(hits.slice(0, 2));
    release("local-test-key");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(m.llm).not.toHaveBeenCalled();
  });

  it("propagates a Stop request instead of continuing with search results", async () => {
    m.key.mockResolvedValue(undefined);
    m.llm.mockImplementation(() => new Promise(() => {}));
    const parent = new AbortController();
    const timedOut = vi.fn();
    const answer = withModelRequest(parent.signal, () => rerank("What does the policy say?", hits, 2, timedOut));
    const stopped = expect(answer).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    parent.abort();
    await stopped;
    expect(timedOut).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets the answer use search results when the optional model has no credits", async () => {
    m.key.mockResolvedValue(undefined);
    m.llm.mockImplementation(async () => providerFailure(new Error("insufficient_quota")));
    const parent = new AbortController();
    expect(await withModelRequest(parent.signal, async () => {
      const top = await rerank("What does the policy say?", hits, 2);
      return top.map(hit => hit.id);
    })).toEqual(["policy-a", "policy-b"]);
  });
});
