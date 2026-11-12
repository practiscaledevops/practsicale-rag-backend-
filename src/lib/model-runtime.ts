import { reserveUsage } from "@/lib/provider-usage";
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
      const abortSignal = modelSignal(type === "stream" ? 85_000 : 45_000, params.abortSignal);
      abortSignal.throwIfAborted();
      return { ...params, maxTokens: params.maxTokens ?? 8192, abortSignal };
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      const settle = await reserveUsage(model.provider, model.modelId, Buffer.byteLength(JSON.stringify(params)) + 1024, (params.maxTokens ?? 8192) + (/^gpt-[5-9](?:[.-]|$)/.test(model.modelId) ? 2048 : 0));
      params.abortSignal?.throwIfAborted();
      const result = await doGenerate();
      await settle(result.usage.promptTokens, result.usage.completionTokens);
      return result;
    },
    wrapStream: async ({ doStream, params }) => {
      const settle = await reserveUsage(model.provider, model.modelId, Buffer.byteLength(JSON.stringify(params)) + 1024, (params.maxTokens ?? 8192) + (/^gpt-[5-9](?:[.-]|$)/.test(model.modelId) ? 2048 : 0));
      params.abortSignal?.throwIfAborted();
      const result = await doStream();
      return { ...result, stream: result.stream.pipeThrough(new TransformStream({
        async transform(part, controller) {
          if (part.type === "finish") await settle(part.usage.promptTokens, part.usage.completionTokens);
          controller.enqueue(part);
        },
      })) };
    },
  } });
}
