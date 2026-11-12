/** Cancel provider work even when metering/persistence still reads a tee. */
export function cancellableBody<T>(
  source: ReadableStream<T>,
  abort: AbortController,
): ReadableStream<T> {
  const reader = source.getReader();
  let canceled = false;
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (canceled) return;
        if (next.done) {
          reader.releaseLock();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        if (!canceled) controller.error(error);
      }
    },
    cancel(reason) {
      canceled = true;
      abort.abort(reason ?? new DOMException("Response canceled", "AbortError"));
      // A tee's cancel promise waits for every other branch. Do not hold the
      // browser's Stop while the server's readers handle the aborted upstream.
      void reader.cancel(reason).catch(() => {});
    },
  });
}
