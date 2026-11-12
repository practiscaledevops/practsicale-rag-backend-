import { AsyncLocalStorage } from "node:async_hooks";
import { wrapLanguageModel, type LanguageModelV1 } from "ai";

// Every model call in a request inherits its cancellation and total deadline.
// Standalone ingestion/helpers also get a finite provider deadline.
const requests = new AsyncLocalStorage<AbortSignal>();
export function withModelRequest<T>(signal: AbortSignal, work: () => T): T {
  return requests.run(signal, work);
}
export function modelSignal(timeoutMs: number, caller?: AbortSignal): AbortSignal {
  const request = requests.getStore();
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (request) signals.push(request);
  if (caller) signals.push(caller);
  return AbortSignal.any(signals);
}
export function boundModel(model: LanguageModelV1): LanguageModelV1 {
  return wrapLanguageModel({ model, middleware: {
    transformParams: async ({ type, params }) => {
      const abortSignal = modelSignal(type === "stream" ? 270_000 : 90_000, params.abortSignal);
      abortSignal.throwIfAborted();
      return { ...params, abortSignal };
    },
  } });
}
