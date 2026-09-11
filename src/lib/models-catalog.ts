// Typed catalog of selectable chat models, grouped by provider.
//
// Powers the consumer app's model dropdown via GET /api/v1/models and documents
// which tier (fast / recommended / max) each model is the default for. A model's
// availability is derived from whether its provider's API key is present in the
// environment — an unavailable model can still be shown in the UI, but disabled.
//
// Keep the pricing map in src/lib/pricing.ts in sync when models are added here.

export type Provider = "anthropic" | "openai";
export type ModelTier = "fast" | "recommended" | "max";

export interface ModelEntry {
  id: string;
  provider: Provider;
  label: string;
  /** Set when this model is the default for a tier (fast / recommended / max). */
  tier?: ModelTier;
}

export type AvailabilityStatus = "available" | "unavailable";

export interface Availability {
  status: AvailabilityStatus;
  /** Present only when unavailable, e.g. "no api key". */
  reason?: string;
}

export interface CatalogModel extends ModelEntry {
  availability: Availability;
}

// The selectable models. Order is provider-grouped, fast -> max within a group.
// The three tier-tagged Anthropic entries mirror the tier defaults in llm.ts.
export const MODELS: ModelEntry[] = [
  // Anthropic (Claude)
  { id: "claude-haiku-4-5", provider: "anthropic", label: "Claude Haiku 4.5", tier: "fast" },
  { id: "claude-sonnet-4-6", provider: "anthropic", label: "Claude Sonnet 4.6", tier: "recommended" },
  { id: "claude-opus-4-8", provider: "anthropic", label: "Claude Opus 4.8", tier: "max" },
  { id: "claude-sonnet-5", provider: "anthropic", label: "Claude Sonnet 5 (new)" },
  { id: "claude-opus-5", provider: "anthropic", label: "Claude Opus 5 (new)" },
  // OpenAI (GPT)
  { id: "gpt-4o-mini", provider: "openai", label: "GPT-4o mini" },
  { id: "gpt-4o", provider: "openai", label: "GPT-4o" },
  { id: "gpt-5", provider: "openai", label: "GPT-5 (new)" },
];

// Which env var holds each provider's API key. Presence == available.
const PROVIDER_KEY_ENV: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

/** Availability for a provider: 'available' iff its API key env var is set. */
export function availability(provider: Provider): Availability {
  const present = Boolean(process.env[PROVIDER_KEY_ENV[provider]]);
  return present ? { status: "available" } : { status: "unavailable", reason: "no api key" };
}

// Models that REJECT a custom `temperature` (and other sampling params). The
// newest Anthropic models (Opus 4.8 and the Claude 5 family) return HTTP 400
// "`temperature` is deprecated for this model." if temperature is sent. Passing
// sampling params to these must be avoided or the whole generation 400s and the
// client gets an empty/errored stream. (The @ai-sdk/openai provider already
// strips temperature for OpenAI reasoning models like gpt-5/o-series, so this
// guard is only needed for Anthropic — but it is written to be safe for any id.)
const NO_TEMPERATURE_IDS = new Set<string>([
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-opus-5",
]);

/**
 * Whether a model accepts a custom `temperature`. Defaults to true; false for
 * the known newer models that deprecate sampling params, and for any future
 * Claude 5.x+ id (guarded by pattern so new versions don't reintroduce the bug).
 */
export function supportsTemperature(modelId: string | undefined | null): boolean {
  if (!modelId) return true;
  if (NO_TEMPERATURE_IDS.has(modelId)) return false;
  // Claude 5+ (any variant) deprecates temperature; be safe for future ids.
  if (/^claude-(?:opus|sonnet|haiku)-(?:[5-9]|\d{2,})/.test(modelId)) return false;
  return true;
}

/**
 * Build the sampling/generation params to spread into streamText/generateText for
 * a given model. Omits `temperature` for models that reject it, always sets
 * `maxTokens`. Use everywhere a model is called so switching models never 400s.
 */
export function generationParams(
  modelId: string | undefined | null,
  opts: { temperature?: number; maxTokens?: number }
): { temperature?: number; maxTokens?: number } {
  const params: { temperature?: number; maxTokens?: number } = {};
  if (typeof opts.maxTokens === "number") params.maxTokens = opts.maxTokens;
  if (typeof opts.temperature === "number" && supportsTemperature(modelId)) {
    params.temperature = opts.temperature;
  }
  return params;
}

/** The full catalog with per-model availability resolved from the environment. */
export function getCatalog(): CatalogModel[] {
  return MODELS.map((m) => ({ ...m, availability: availability(m.provider) }));
}
