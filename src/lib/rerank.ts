import {hasRequestBudget} from '@/lib/request-budget';
import type { RetrievedChunk } from "./retrieval";
import { getProviderKey } from "@/lib/secrets";
import { llmRerank } from "@/lib/llm-rerank";
import { currentModelRequestSignal, withModelRequest } from "@/lib/model-runtime";

// Reranking of retrieval candidates — the second stage of the RAG pipeline.
// hybridSearchScoped() returns a wide candidate pool, then rerank() picks the top
// N most relevant. Wired into both grounded paths (POST /api/v1/retrieve and
// /api/v1/chat) and the admin playground, so quality is consistent.
//
// Provider order (all graceful):
//   1. Cohere cross-encoder — if a COHERE_API_KEY is configured (fastest, paid).
//   2. LLM rerank with the "fast" tier (e.g. Haiku) — FREE (reuses existing model
//      spend), no extra vendor. This is the default when no Cohere key is set.
//   3. Original top-N — if both fail or the shared time budget expires.
// Each reranked chunk carries a `score` in [0,1] used for the confidence signal.
export const RERANK_TIME_LIMIT_MS = 1_500;

export async function rerank(
  query: string,
  chunks: RetrievedChunk[],
  topN = 8,
  onTimeout?: () => void,
): Promise<RetrievedChunk[]> {
  const original = chunks.slice(0, topN);
  if (chunks.length <= topN) return original;

  const parent = currentModelRequestSignal();
  parent?.throwIfAborted();
  const deadline = new AbortController();
  const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), RERANK_TIME_LIMIT_MS);
  let onAbort!: () => void;
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    // Optional provider failures must not cancel the rest of the model request.
    const attempt = withModelRequest(signal, () => rankWithProviders(query, chunks, topN, signal)).catch(() => null);
    const ranked = await Promise.race([attempt, aborted]);
    parent?.throwIfAborted();
    if (deadline.signal.aborted) {
      console.info("[rerank-timeout]", JSON.stringify({ limitMs: RERANK_TIME_LIMIT_MS, candidates: chunks.length }));
      onTimeout?.();
      return original;
    }
    return ranked ?? original;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

async function rankWithProviders(query: string, chunks: RetrievedChunk[], topN: number, signal: AbortSignal) {
  if (!hasRequestBudget()) {
    const key = await getProviderKey("cohere");
    signal.throwIfAborted();
    if (key) {
      const cohere = await cohereRerank(query, chunks, topN, key, signal);
      if (cohere) return cohere;
    }
  }
  signal.throwIfAborted();
  return llmRerank(query, chunks, topN, "fast", signal);
}

/** Cohere v2 rerank. Returns null on any failure so the caller can fall back. */
async function cohereRerank(
  query: string,
  chunks: RetrievedChunk[],
  topN: number,
  key: string,
  signal: AbortSignal,
): Promise<RetrievedChunk[] | null> {
  try {
    const res = await fetch("https://api.cohere.com/v2/rerank", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "rerank-v3.5",
        query,
        documents: chunks.map((c) => c.content),
        top_n: topN,
      }),
      signal,
    });
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
