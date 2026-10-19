import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel, type LanguageModelV1, type LanguageModelV1Middleware } from "ai";
import { getProviderKey } from "@/lib/secrets";
import { supportsTemperature } from "@/lib/models-catalog";

// Selectable model tiers (see docs/00-master-plan.md §0.10). The UI exposes these
// with "recommended" as the default; hard queries can escalate to "max".
export type Tier = "fast" | "recommended" | "max";

const TIER_ENV: Record<Tier, string> = {
  fast: process.env.FAST_CHAT_MODEL ?? "gpt-6-luna",
  recommended: process.env.RECOMMENDED_CHAT_MODEL ?? "gpt-6.1-sol",
  max: process.env.MAX_CHAT_MODEL ?? "gpt-6-astra",
};

function isTier(v: unknown): v is Tier {
  return v === "fast" || v === "recommended" || v === "max";
}

// The `ai` v4 core hard-defaults `temperature` to 0 when a call omits it
// (`temperature != null ? temperature : 0`), and the Anthropic provider forwards
// it. The newest models (Opus 4.8 + Claude 5 family) return HTTP 400
// "`temperature` is deprecated for this model." So omitting temperature at the
// call site is NOT enough — the core re-adds it. This middleware runs AFTER the
// core standardizes params and BEFORE the provider builds its request, and strips
// the sampling params those models reject. Centralized here so every caller
// (public chat, playground, query-rewrite, router, faithfulness, contextualize)
// is fixed at once, and future no-temperature models are covered by the predicate.
const stripSamplingParams: LanguageModelV1Middleware = {
  transformParams: async ({ params }) => ({
    ...params,
    temperature: undefined,
    topP: undefined,
    topK: undefined,
  }),
};

/** Wrap a model so it never sends sampling params it would 400 on. No-op otherwise. */
function guardSamplingParams(model: LanguageModelV1): LanguageModelV1 {
  return supportsTemperature(model.modelId)
    ? model
    : wrapLanguageModel({ model, middleware: stripSamplingParams });
}

// AI SDK v4 recognizes GPT-5 reasoning models but predates GPT-6. Adapt its
// request at the model boundary so every caller (including generateObject and
// tiny helper calls) uses the supported completion budget and reasoning params.
function openAIModel(id: string, apiKey?: string): LanguageModelV1 {
  const provider = createOpenAI({ apiKey, compatibility: "strict" });
  if (!/^gpt-[5-9](?:[.-]|$)/.test(id)) return guardSamplingParams(provider(id));
  const base = provider.chat(id, { structuredOutputs: true, reasoningEffort: "low" });
  return wrapLanguageModel({ model: base, middleware: {
    transformParams: async ({ params }) => ({
      ...params,
      temperature: undefined, topP: undefined, topK: undefined,
      maxTokens: undefined,
      providerMetadata: {
        ...params.providerMetadata,
        openai: {
          ...params.providerMetadata?.openai,
          // Completion budget includes hidden reasoning. A 40-token router or
          // 300-token verifier must still have room to reason and emit its JSON.
          maxCompletionTokens: (params.maxTokens ?? 4096) + 2048,
          reasoningEffort: "low",
        },
      },
    }),
  } });
}

/** Resolve a concrete model id from a tier name, an explicit id, or the default. */
function resolveId(tierOrId?: string): string {
  if (isTier(tierOrId)) return TIER_ENV[tierOrId];
  if (tierOrId) return tierOrId; // explicit model id
  return TIER_ENV.recommended;
}

/**
 * Resolve a provider model, using the API key from the dashboard store (DB) with
 * an env fallback (see lib/secrets). This is the path the pipeline uses so an
 * admin can rotate keys from the UI without a redeploy. Async because it reads
 * the resolved key.
 */
export async function getModel(tierOrId?: string) {
  const id = resolveId(tierOrId);
  if (id.startsWith("claude")) {
    const apiKey = await getProviderKey("anthropic");
    return guardSamplingParams(createAnthropic({ apiKey })(id));
  }
  const apiKey = await getProviderKey("openai");
  // The v1 provider defaults to OpenAI-compatible mode, which omits
  // stream_options.include_usage. Official OpenAI streams then have NaN token
  // counts: metering inserts fail and the spoke records zero usage/cost.
  return openAIModel(id, apiKey);
}

// ---- Env-only variants (kept for callers/scripts that don't resolve DB keys) ----

/** Resolve a model from a tier name, an explicit model id, or the default (env keys). */
export function modelForTier(tierOrId?: string) {
  return model(resolveId(tierOrId));
}

/** Choose a provider model by id using the default (env) credentials. */
export function model(name?: string) {
  const id = name ?? TIER_ENV.recommended;
  return id.startsWith("claude") ? guardSamplingParams(anthropic(id)) : openAIModel(id);
}

// TODO: route through the Vercel AI Gateway for automatic provider failover
// (see docs/07-cost-and-scaling.md).
