import type { RetrievedChunk } from "./retrieval";
import { getProviderKey } from "@/lib/secrets";
import { llmRerank } from "@/lib/llm-rerank";

// Reranking of retrieval candidates — the second stage of the RAG pipeline.
// hybridSearchScoped() returns a wide candidate pool, then rerank() picks the top
// N most relevant. Wired into both grounded paths (POST /api/v1/retrieve and
// /api/v1/chat) and the admin playground, so quality is consistent.
//
// Provider order (all graceful):
//   1. Cohere cross-encoder — if a COHERE_API_KEY is configured (fastest, paid).
//   2. LLM rerank with the "fast" tier (e.g. Haiku) — FREE (reuses existing model
//      spend), no extra vendor. This is the default when no Cohere key is set.
//   3. Plain top-N — if neither is available or both fail.
// Each reranked chunk carries a `score` in [0,1] used for the confidence signal.

export async function rerank(
  query: string,
  chunks: RetrievedChunk[],
  topN = 8
): Promise<RetrievedChunk[]> {
  if (chunks.length <= topN) return chunks.slice(0, topN);

  const key = await getProviderKey("cohere");

  // 1. Cohere, when configured.
  if (key) {
    const cohere = await cohereRerank(query, chunks, topN, key);
    if (cohere) return cohere;
  }

  // 2. Free LLM rerank (Haiku). Null on failure ⇒ fall through to top-N.
  const llm = await llmRerank(query, chunks, topN, "fast");
  if (llm && llm.length > 0) return llm;

  // 3. Plain top-N.
  return chunks.slice(0, topN);
}

/** Cohere v2 rerank. Returns null on any failure so the caller can fall back. */
async function cohereRerank(
  query: string,
  chunks: RetrievedChunk[],
  topN: number,
  key: string
): Promise<RetrievedChunk[] | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let res: Response;
    try {
      res = await fetch("https://api.cohere.com/v2/rerank", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "rerank-v3.5",
          query,
          documents: chunks.map((c) => c.content),
          top_n: topN,
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;

    const json = (await res.json()) as {
      results?: { index: number; relevance_score?: number }[];
    };
    const ranked: RetrievedChunk[] = [];
    for (const r of json.results ?? []) {
      const c = chunks[r.index];
      if (!c) continue;
      ranked.push(
        typeof r.relevance_score === "number" ? { ...c, score: r.relevance_score } : c
      );
    }
    return ranked.length > 0 ? ranked.slice(0, topN) : null;
  } catch {
    return null;
  }
}
