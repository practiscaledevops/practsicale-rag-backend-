import type { RetrievedChunk } from "./retrieval";

// Rerank candidates with Cohere. Returns the top N most relevant.
// If no key is set, returns the input unchanged (graceful degradation).
export async function rerank(
  query: string,
  chunks: RetrievedChunk[],
  topN = 8
): Promise<RetrievedChunk[]> {
  const key = process.env.COHERE_API_KEY;
  if (!key || chunks.length <= topN) return chunks.slice(0, topN);

  const res = await fetch("https://api.cohere.com/v2/rerank", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "rerank-v3.5",
      query,
      documents: chunks.map((c) => c.content),
      top_n: topN,
    }),
  });
  if (!res.ok) return chunks.slice(0, topN);
  const json = (await res.json()) as { results: { index: number }[] };
  return json.results.map((r) => chunks[r.index]);
}
