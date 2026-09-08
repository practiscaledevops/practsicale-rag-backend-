// Query transformation — rewrite the user's latest question into a single,
// self-contained search query before retrieval. This lifts recall on
// conversational / pronoun-heavy questions ("why did that drop?") by resolving
// references against the conversation.
//
// Runs on a cheap/fast model. Graceful: demo mode, a missing key, or any error
// returns the original query unchanged, so retrieval always proceeds.

import { generateText } from "ai";
import { getModel } from "@/lib/llm";
import { isDemo } from "@/lib/demo/mode";

export interface ChatTurn {
  role: string;
  content: string;
}

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
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  try {
    const { text } = await generateText({
      model: await getModel(tier),
      system: systemPrompt,
      prompt: recent
        ? `Conversation so far:\n${recent}\n\nLatest question: ${query}\n\nRewritten standalone search query:`
        : `Question: ${query}\n\nRewritten standalone search query:`,
      temperature: 0,
      maxTokens: 128,
    });
    const rewritten = text.trim();
    // Guard against a model that returns nothing useful or an over-long blob.
    if (!rewritten || rewritten.length > 500) return query;
    return rewritten;
  } catch {
    return query;
  }
}
