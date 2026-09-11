// Contextual retrieval (Anthropic's technique) — generate a short blurb that
// situates each chunk within its source document, to be prepended before the
// chunk is embedded and full-text indexed. This dramatically cuts failed
// retrievals because an isolated chunk ("it rose 12%") gains the context it needs
// ("Q3 closing-rate section of the March coaching report for consultant A. Rai").
//
// Cost/latency is bounded: context is generated on a cheap tier, with a
// concurrency limit and a per-document chunk cap (both configurable). Graceful:
// demo mode, a missing key, an over-cap document, or any error yields empty
// contexts, so ingestion always succeeds (falling back to plain chunk retrieval).

import { generateText } from "ai";
import { getModel } from "@/lib/llm";
import { generationParams } from "@/lib/models-catalog";
import { isDemo } from "@/lib/demo/mode";

export interface ContextualizeOptions {
  systemPrompt: string;
  tier: "fast" | "recommended" | "max";
  concurrency: number;
  maxChunksPerDoc: number;
}

/** Keep the cached document reasonably sized in the prompt (chars ≈ 4/token). */
const MAX_DOC_CHARS = 60_000;

/**
 * Generate a situating context for every chunk. Returns an array aligned 1:1 with
 * `chunkContents` (empty string where no context was generated). Never throws.
 */
export async function contextualizeChunks(
  documentText: string,
  chunkContents: string[],
  opts: ContextualizeOptions
): Promise<string[]> {
  const empty = chunkContents.map(() => "");
  if (isDemo()) return empty;
  if (chunkContents.length === 0) return empty;
  // Cost guard: skip very large documents entirely.
  if (chunkContents.length > opts.maxChunksPerDoc) return empty;

  const doc = documentText.length > MAX_DOC_CHARS
    ? documentText.slice(0, MAX_DOC_CHARS)
    : documentText;

  const out = [...empty];
  const concurrency = Math.max(1, Math.min(20, opts.concurrency));
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= chunkContents.length) return;
      out[i] = await oneContext(doc, chunkContents[i], opts).catch(() => "");
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

async function oneContext(
  doc: string,
  chunk: string,
  opts: ContextualizeOptions
): Promise<string> {
  const m = await getModel(opts.tier);
  const { text } = await generateText({
    model: m,
    system: opts.systemPrompt,
    prompt: `<document>\n${doc}\n</document>\n\n<chunk>\n${chunk}\n</chunk>\n\nContext for this chunk:`,
    ...generationParams(m.modelId, { temperature: 0, maxTokens: 120 }),
  });
  const ctx = text.trim();
  // Guard: never let context balloon past the chunk itself.
  return ctx.length > 600 ? ctx.slice(0, 600) : ctx;
}
