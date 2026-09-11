import type { RetrievedChunk } from "./retrieval";
import { getProviderKey } from "@/lib/secrets";

// Cross-encoder reranking of retrieval candidates with Cohere.
//
// This is the second stage of the RAG pipeline: hybridSearchScoped() returns a
// wide candidate pool, then rerank() picks the top N most relevant. It is wired
// into BOTH grounded paths — the public POST /api/v1/retrieve and POST
// /api/v1/chat, and the admin playground — so retrieval quality is consistent.
//
// Graceful degradation: with no COHERE_API_KEY (or on any Cohere error) it
// simply returns the first N candidates unchanged, so retrieval still works
// end-to-end without a rerank provider. No key is required for the Brain to run.

// Rerank candidates with Cohere. Returns the top N most relevant.
// If no key is set, returns the input unchanged (graceful degradation).
export async function rerank(
  query: string,
  chunks: RetrievedChunk[],
  topN = 8
): Promise<RetrievedChunk[]> {
  const key = await getProviderKey("cohere");
  if (!key || chunks.length <= topN) return chunks.slice(0, topN);

  // Never let a rerank hiccup (network error, timeout, non-200, malformed body,
  // or an out-of-range index) crash retrieval — fall back to the top-N pool. A
  // thrown error here would otherwise bubble into the chat stream as an empty,
  // un-metered answer.
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
    if (!res.ok) return chunks.slice(0, topN);

    const json = (await res.json()) as { results?: { index: number }[] };
    const ranked = (json.results ?? [])
      .map((r) => chunks[r.index])
      .filter((c): c is RetrievedChunk => Boolean(c));
    // If Cohere returned nothing usable, keep the original top-N.
    return ranked.length > 0 ? ranked.slice(0, topN) : chunks.slice(0, topN);
  } catch {
    return chunks.slice(0, topN);
  }
}
