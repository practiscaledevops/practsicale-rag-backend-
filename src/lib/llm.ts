import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { openai, createOpenAI } from "@ai-sdk/openai";
import { getProviderKey } from "@/lib/secrets";

// Selectable model tiers (see docs/00-master-plan.md §0.10). The UI exposes these
// with "recommended" as the default; hard queries can escalate to "max".
export type Tier = "fast" | "recommended" | "max";

const TIER_ENV: Record<Tier, string> = {
  fast: process.env.FAST_CHAT_MODEL ?? "claude-haiku-4-5",
  recommended: process.env.RECOMMENDED_CHAT_MODEL ?? "claude-sonnet-4-6",
  max: process.env.MAX_CHAT_MODEL ?? "claude-opus-4-8",
};

function isTier(v: unknown): v is Tier {
  return v === "fast" || v === "recommended" || v === "max";
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
    return createAnthropic({ apiKey })(id);
  }
  const apiKey = await getProviderKey("openai");
  return createOpenAI({ apiKey })(id);
}

// ---- Env-only variants (kept for callers/scripts that don't resolve DB keys) ----

/** Resolve a model from a tier name, an explicit model id, or the default (env keys). */
export function modelForTier(tierOrId?: string) {
  return model(resolveId(tierOrId));
}

/** Choose a provider model by id using the default (env) credentials. */
export function model(name?: string) {
  const id = name ?? TIER_ENV.recommended;
  if (id.startsWith("claude")) return anthropic(id);
  return openai(id);
}

// TODO: route through the Vercel AI Gateway for automatic provider failover
// (see docs/07-cost-and-scaling.md).
