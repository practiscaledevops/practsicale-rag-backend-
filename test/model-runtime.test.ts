import { describe, expect, it, vi } from "vitest";
import { boundModel, modelSignal, withModelRequest } from "@/lib/model-runtime";

describe("request cancellation reaches every model helper", () => {
  it("keeps concurrent requests isolated", async () => {
    const first = new AbortController(), second = new AbortController();
    const a = withModelRequest(first.signal, () => modelSignal(30_000));
    const b = withModelRequest(second.signal, () => modelSignal(30_000));
    first.abort();
    expect(a.aborted).toBe(true); expect(b.aborted).toBe(false);
  });
  it("honors a shorter caller deadline", async () => {
    const caller = new AbortController();
    const signal = modelSignal(30_000, caller.signal);
    caller.abort("short helper deadline"); expect(signal.reason).toBe("short helper deadline");
  });
  it("times out helper work without a request context", async () => {
    const signal = modelSignal(5);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(signal.aborted).toBe(true); expect(signal.reason.name).toBe("TimeoutError");
  });
  it("never starts a provider call after the user canceled", async () => {
    const doGenerate = vi.fn();
    const model = boundModel({ specificationVersion: "v1", provider: "fixture", modelId: "fixture", doGenerate } as any);
    const abort = new AbortController(); abort.abort();
    await expect(withModelRequest(abort.signal, () => model.doGenerate({} as any))).rejects.toHaveProperty("name", "AbortError");
    expect(doGenerate).not.toHaveBeenCalled();
  });
  it("passes cancellation to a provider already in flight", async () => {
    let observed!: AbortSignal;
    const doGenerate = vi.fn(async (params: any) => {
      observed = params.abortSignal;
      return new Promise((_resolve, reject) => observed.addEventListener("abort", () => reject(observed.reason), { once: true }));
    });
    const model = boundModel({ specificationVersion: "v1", provider: "fixture", modelId: "fixture", doGenerate } as any);
    const abort = new AbortController();
    const result = withModelRequest(abort.signal, () => Promise.resolve(model.doGenerate({} as any))).catch(e => e);
    await vi.waitFor(() => expect(doGenerate).toHaveBeenCalledOnce());
    abort.abort();
    expect((await result).name).toBe("AbortError"); expect(observed.aborted).toBe(true);
  });
});
