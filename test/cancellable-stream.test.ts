import { describe, expect, it } from "vitest";
import { cancellableBody } from "@/lib/cancellable-stream";

describe("canceling a streamed answer", () => {
  it("stops upstream work even while the server reads the other tee", async () => {
    const abort = new AbortController();
    let source!: ReadableStreamDefaultController<string>;
    const upstream = new ReadableStream<string>({ start(c) { source = c; } });
    abort.signal.addEventListener("abort", () => source.error(abort.signal.reason), { once: true });
    const [browser, metering] = upstream.tee();
    const meterRead = metering.getReader().read().catch(error => error);
    await cancellableBody(browser, abort).cancel();
    expect(abort.signal.aborted).toBe(true);
    expect((await meterRead).name).toBe("AbortError");
  });

  it("preserves bytes and leaves ordinary completed/background work alone", async () => {
    const abort = new AbortController();
    const source = new ReadableStream<Uint8Array>({ start(c) {
      c.enqueue(new TextEncoder().encode("complete answer")); c.close();
    } });
    expect(await new Response(cancellableBody(source, abort)).text()).toBe("complete answer");
    expect(abort.signal.aborted).toBe(false);
  });

  it("releases a pending read when Stop arrives", async () => {
    const abort = new AbortController();
    const source = new ReadableStream<string>({});
    const reader = cancellableBody(source, abort).getReader();
    const pending = reader.read();
    await reader.cancel("stop");
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(abort.signal.aborted).toBe(true);
  });
});
