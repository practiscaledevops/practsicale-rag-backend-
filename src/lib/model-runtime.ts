import { reserveUsage } from "@/lib/provider-usage";
import { AsyncLocalStorage } from "node:async_hooks";
import { wrapLanguageModel, type LanguageModelV1 } from "ai";

// Every model call in a request inherits its cancellation and total deadline.
// Standalone ingestion/helpers also get a finite provider deadline.
type RequestState={signal:AbortSignal;fail:(error:Error)=>void;fatal?:Error};
const requests = new AsyncLocalStorage<RequestState>();
export function providerFailure(error:unknown):never {
 const value=error as {message?:string;responseBody?:string;code?:string};
 if(/insufficient_quota|no credits remaining|exceeded your current quota/i.test([value?.message,value?.responseBody,value?.code].join(' '))){
  const failure=new Error('MODEL_CREDITS_UNAVAILABLE');const state=requests.getStore();if(state){state.fatal=failure;state.fail(failure);}throw failure;
 }
 throw error;
}
export function withModelRequest<T>(signal: AbortSignal, work: () => T): T {
  const cancel=new AbortController();
  let fail!:(error:Error)=>void;
  const fatal=new Promise<never>((_,reject)=>{fail=reject;});fatal.catch(()=>{});
  return requests.run({signal:AbortSignal.any([signal,cancel.signal]),fail:(error)=>{cancel.abort(error);fail(error);}},()=>{const result=work();return result instanceof Promise?Promise.race([result,fatal]) as T:result;});
}
export function currentModelRequestSignal(): AbortSignal | undefined {
  return requests.getStore()?.signal;
}
export function modelSignal(timeoutMs: number, caller?: AbortSignal): AbortSignal {
  const request = requests.getStore();
  const signals = [AbortSignal.timeout(timeoutMs)];
  if(request?.fatal) throw request.fatal;
  if (request) signals.push(request.signal);
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
      const result = await Promise.resolve(doGenerate()).catch(providerFailure);
      await settle(result.usage.promptTokens, result.usage.completionTokens);
      return result;
    },
    wrapStream: async ({ doStream, params }) => {
      const settle = await reserveUsage(model.provider, model.modelId, Buffer.byteLength(JSON.stringify(params)) + 1024, (params.maxTokens ?? 8192) + (/^gpt-[5-9](?:[.-]|$)/.test(model.modelId) ? 2048 : 0));
      params.abortSignal?.throwIfAborted();
      const result = await Promise.resolve(doStream()).catch(providerFailure);
      return { ...result, stream: result.stream.pipeThrough(new TransformStream({
        async transform(part, controller) {
          if (part.type === "finish") await settle(part.usage.promptTokens, part.usage.completionTokens);
          controller.enqueue(part);
        },
      })) };
    },
  } });
}
