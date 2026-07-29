// Per-1M-token pricing (USD) for chat models, used to estimate the cost_usd
// written to usage_events so Analytics can show spend.
//
// ESTIMATES ONLY — the provider's billing is the source of truth. These rates
// drift; keep them roughly current and treat any dashboard figure as indicative.
// Keys are matched by longest-prefix against the resolved model id, so a family
// key like "claude-opus" covers "claude-opus-4-8", "claude-opus-5", etc.

export interface Rate {
  inputPer1M: number;
  outputPer1M: number;
}

export const PRICING: Record<string, Rate> = {
  // Anthropic (Claude) — family-level keys.
  "claude-opus": { inputPer1M: 5, outputPer1M: 25 },
  "claude-sonnet": { inputPer1M: 3, outputPer1M: 15 },
  "claude-haiku": { inputPer1M: 1, outputPer1M: 5 },
  // OpenAI (GPT) — the "gpt-4o-mini" key wins over "gpt-4o" via longest-prefix.
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
  "gpt-5": { inputPer1M: 5, outputPer1M: 30 }, // estimate — no public list rate yet
};

// Fallback when a model id matches no key (~= Sonnet), so a new/unknown model
// still meters a plausible non-zero cost rather than silently costing $0.
const DEFAULT_RATE: Rate = { inputPer1M: 3, outputPer1M: 15 };

/** Longest-prefix match so "gpt-4o-mini" is not swallowed by "gpt-4o". */
function rateFor(model: string): Rate {
  const keys = Object.keys(PRICING)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length);
  return keys.length ? PRICING[keys[0]] : DEFAULT_RATE;
}

/**
 * Estimated USD cost of one call.
 * ESTIMATES ONLY — provider billing is the source of truth.
 */
export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const r = rateFor(model);
  return (inputTokens / 1e6) * r.inputPer1M + (outputTokens / 1e6) * r.outputPer1M;
}
