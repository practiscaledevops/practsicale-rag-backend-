// Decide which data source(s) to search for a given query.
//
// Two strategies, chosen by settings:
//   - keyword (default): instant, no model call. Good enough for most queries.
//   - llm:  a cheap model picks the source type(s), using the editable `router`
//           prompt. Slightly slower but handles nuanced routing.
//
// Either way the result is intersected with the API key's allowed source_types
// downstream, so routing can only ever NARROW within what the key already permits.

import { generateText } from "ai";
import { getModel } from "@/lib/llm";
import { generationParams } from "@/lib/models-catalog";
import { isDemo } from "@/lib/demo/mode";

export type SourceType = "transcript" | "call_score" | "coaching" | "document" | null;

const KNOWN: Exclude<SourceType, null>[] = ["transcript", "call_score", "coaching", "document"];

/** Fast keyword router. Returns a single best-guess source_type, or null (all). */
export function routeQuery(query: string): SourceType {
  const q = query.toLowerCase();
  if (q.includes("score") || q.includes("rating")) return "call_score";
  if (q.includes("coach") || q.includes("recommend")) return "coaching";
  if (q.includes("transcript") || q.includes("said") || q.includes("call")) return "transcript";
  return null; // search across all sources
}

/**
 * LLM router: return the source types to search (subset of KNOWN), or [] to mean
 * "search all". Graceful: demo / errors fall back to the keyword router's guess.
 * @param systemPrompt the active `router` prompt (from the DB or default)
 */
export async function routeQueryLLM(
  query: string,
  systemPrompt: string,
  tier: "fast" | "recommended" | "max" = "fast"
): Promise<string[]> {
  const keywordGuess = routeQuery(query);
  if (isDemo() || !query.trim()) return keywordGuess ? [keywordGuess] : [];

  try {
    const m = await getModel(tier);
    const { text } = await generateText({
      model: m,
      system: systemPrompt,
      prompt: `Question: ${query}\n\nSource types to search:`,
      ...generationParams(m.modelId, { temperature: 0, maxTokens: 40 }),
    });
    const raw = text.toLowerCase();
    if (raw.includes("all")) return [];
    const picked = KNOWN.filter((t) => raw.includes(t));
    if (picked.length > 0) return picked;
    return keywordGuess ? [keywordGuess] : [];
  } catch {
    return keywordGuess ? [keywordGuess] : [];
  }
}
