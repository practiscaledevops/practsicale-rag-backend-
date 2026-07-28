import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";

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

/** Resolve a model from a tier name, an explicit model id, or the default. */
export function modelForTier(tierOrId?: string) {
  if (isTier(tierOrId)) return model(TIER_ENV[tierOrId]);
  if (tierOrId) return model(tierOrId); // explicit model id
  return model(TIER_ENV.recommended);
}

/** Choose a provider model by id. Extend as new models are added. */
export function model(name?: string) {
  const id = name ?? TIER_ENV.recommended;
  if (id.startsWith("claude")) return anthropic(id);
  return openai(id);
}

// TODO: route through the Vercel AI Gateway for automatic provider failover
// (see docs/07-cost-and-scaling.md).
