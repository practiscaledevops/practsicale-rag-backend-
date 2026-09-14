// LLM-based reranking — a free alternative to a paid cross-encoder (Cohere).
//
// Asks a cheap model (the "fast" tier, e.g. Haiku) to score each candidate
// passage's relevance to the query and keep the best top-N, in ONE call. This is
// a cross-encoder-style rerank (the model reads the query + each passage together)
// using the LLM spend you already have, so retrieval quality improves without a
// new paid dependency. Graceful: any failure returns null so the caller can fall
// back to the plain top-N.

import { generateText } from "ai";
import { getModel } from "@/lib/llm";
import { generationParams } from "@/lib/models-catalog";
import { isDemo } from "@/lib/demo/mode";
import type { RetrievedChunk } from "@/lib/retrieval";

// Keep the prompt bounded: cap the candidate pool and each passage's length.
const MAX_CANDIDATES = 40;
const MAX_PASSAGE_CHARS = 600;

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Parse the model's JSON ranking: an array of { i, score } (tolerant of prose/fences). */
function parseRanking(text: string): { i: number; score: number }[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(arr)) return null;
    const out: { i: number; score: number }[] = [];
    for (const item of arr) {
      const i = Number((item as { i?: unknown })?.i);
      const scoreRaw = Number((item as { score?: unknown })?.score);
      if (Number.isInteger(i) && i >= 0) {
        out.push({ i, score: Number.isFinite(scoreRaw) ? scoreRaw : 50 });
      }
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/**
 * Rerank `candidates` against `query` with a cheap model, returning up to `topN`
 * chunks (best first) each carrying a `score` in [0,1]. Returns null on any
 * failure so the caller falls back to the unranked top-N.
 */
export async function llmRerank(
  query: string,
  candidates: RetrievedChunk[],
  topN: number,
  tier: "fast" | "recommended" | "max" = "fast"
): Promise<RetrievedChunk[] | null> {
  if (isDemo() || candidates.length === 0 || !query.trim()) return null;

  const pool = candidates.slice(0, MAX_CANDIDATES);
  const passages = pool
    .map((c, i) => `[${i}] ${truncate(c.content.replace(/\s+/g, " ").trim(), MAX_PASSAGE_CHARS)}`)
    .join("\n\n");

  try {
    const m = await getModel(tier);
    const { text } = await generateText({
      model: m,
      system:
        "You rank passages by how well each one helps answer the user's question. Judge relevance only. Output ONLY compact JSON, no prose.",
      prompt:
        `Question:\n${query}\n\nPassages:\n${passages}\n\n` +
        `Return a JSON array of the ${topN} MOST relevant passages, best first, as ` +
        `[{"i": <passage index>, "score": <0-100 relevance>}]. Include only genuinely ` +
        `relevant passages (fewer than ${topN} is fine). Do not invent indices.`,
      ...generationParams(m.modelId, { temperature: 0, maxTokens: 500 }),
    });

    const ranking = parseRanking(text);
    if (!ranking) return null;

    const out: RetrievedChunk[] = [];
    const seen = new Set<string>();
    for (const r of ranking) {
      const c = pool[r.i];
      if (!c || seen.has(c.id)) continue;
      seen.add(c.id);
      const score = Math.max(0, Math.min(100, r.score)) / 100;
      out.push({ ...c, score });
      if (out.length >= topN) break;
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}
