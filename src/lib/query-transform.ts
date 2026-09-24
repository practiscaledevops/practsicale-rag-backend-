// Query transformation — rewrite the user's latest question into a single,
// self-contained search query before retrieval. This lifts recall on
// conversational / pronoun-heavy questions ("why did that drop?") by resolving
// references against the conversation.
//
// Runs on a cheap/fast model. Graceful: demo mode, a missing key, or any error
// returns the original query unchanged, so retrieval always proceeds.

import { generateText } from "ai";
import { getModel } from "@/lib/llm";
import { generationParams } from "@/lib/models-catalog";
import { isDemo } from "@/lib/demo/mode";

export interface ChatTurn {
  role: string;
  content: string;
  /** When the turn was sent (ISO timestamp), if the caller supplied it. Anchors relative dates in call-review continuity. */
  createdAt?: string;
}

// Per-turn / question clip for the rewriter prompt. The history the chat route
// hands over is not size-capped (call-review continuity reads the wide window),
// so a few long pasted turns must not become a ~240k-char prompt on every message.
const MAX_REWRITE_TURN_CHARS = 2000;
const MAX_REWRITE_QUERY_CHARS = 4000;

/**
 * Rewrite `query` into a standalone retrieval query using recent conversation.
 * @param systemPrompt the active `query_rewrite` prompt (from the DB or default)
 */
export async function rewriteQuery(
  query: string,
  history: ChatTurn[],
  systemPrompt: string,
  tier: "fast" | "recommended" | "max" = "fast"
): Promise<string> {
  if (isDemo()) return query;
  if (!query.trim()) return query;

  // Only the last few turns matter for reference resolution; keep the prompt small.
  const recent = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-6)
    .map((m) => `${m.role}: ${m.content.slice(0, MAX_REWRITE_TURN_CHARS)}`)
    .join("\n");
  const question = query.slice(0, MAX_REWRITE_QUERY_CHARS);

  try {
    const m = await getModel(tier);
    const { text } = await generateText({
      model: m,
      system: systemPrompt,
      prompt: recent
        ? `Conversation so far:\n${recent}\n\nLatest question: ${question}\n\nRewritten standalone search query:`
        : `Question: ${question}\n\nRewritten standalone search query:`,
      ...generationParams(m.modelId, { temperature: 0, maxTokens: 128 }),
    });
    const rewritten = text.trim();
    // Guard against a model that returns nothing useful or an over-long blob.
    if (!rewritten || rewritten.length > 500) return query;
    // If the model returned multiple lines (multi-topic), keep the first here;
    // callers that support multi-query use rewriteQueries() instead.
    return rewritten.split(/\r?\n/)[0].trim() || query;
  } catch {
    return query;
  }
}

/**
 * Like rewriteQuery, but returns 1-4 focused search queries — one per distinct
 * topic in a compound question. Enables multi-query retrieval so a question like
 * "what is PractiScale and who is Afra?" retrieves BOTH the company overview and
 * the founder profile, instead of collapsing into one keyword blob.
 * Graceful: demo / errors / trivial input return [query].
 */
export async function rewriteQueries(
  query: string,
  history: ChatTurn[],
  systemPrompt: string,
  tier: "fast" | "recommended" | "max" = "fast"
): Promise<string[]> {
  if (isDemo() || !query.trim()) return [query];

  const recent = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-6)
    .map((m) => `${m.role}: ${m.content.slice(0, MAX_REWRITE_TURN_CHARS)}`)
    .join("\n");
  const question = query.slice(0, MAX_REWRITE_QUERY_CHARS);

  try {
    const m = await getModel(tier);
    const { text } = await generateText({
      model: m,
      system: systemPrompt,
      prompt: recent
        ? `Conversation so far:\n${recent}\n\nLatest question: ${question}\n\nSearch queries:`
        : `Question: ${question}\n\nSearch queries:`,
      ...generationParams(m.modelId, { temperature: 0, maxTokens: 160 }),
    });
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*[-*\d.]+\s*/, "").trim()) // strip any list markers
      .filter((l) => l.length > 1 && l.length <= 200)
      .slice(0, 4);
    return lines.length > 0 ? lines : [query];
  } catch {
    return [query];
  }
}
