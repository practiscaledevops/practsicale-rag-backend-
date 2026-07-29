import OpenAI from "openai";
import { isDemo } from "@/lib/demo/mode";

// maxRetries: 0 — a quota/auth failure won't recover on retry, so fail fast and
// let the keyword fallback kick in instead of stalling the request ~45s.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
const MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-large";
const DIM = Number(process.env.EMBEDDING_DIM ?? 1024);

const zeroVec = () => new Array(DIM).fill(0);

// Resilience: if the embedding provider is unreachable or out of quota, the
// system degrades to keyword-only retrieval instead of failing outright. A
// zero vector makes the semantic (pgvector) leg of hybrid search inert, so
// Reciprocal Rank Fusion falls back to the full-text leg — grounded chat keeps
// working. Set EMBEDDINGS_STRICT=1 to turn failures into hard errors instead.
const STRICT = process.env.EMBEDDINGS_STRICT === "1";
let warned = false;
function onEmbedError(err: unknown): void {
  if (STRICT) throw err;
  if (!warned) {
    warned = true;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[embeddings] provider unavailable, falling back to keyword-only retrieval: ${msg}`);
  }
}

// Embed a single string, truncated to DIM dimensions. Demo/outage -> zero vector.
export async function embed(text: string): Promise<number[]> {
  if (isDemo()) return zeroVec();
  try {
    const res = await openai.embeddings.create({ model: MODEL, input: text, dimensions: DIM });
    return res.data[0].embedding;
  } catch (err) {
    onEmbedError(err);
    return zeroVec();
  }
}

// Batch embed (ingestion). Demo/outage -> zero vectors (rows stay full-text
// searchable; re-ingest once the provider is back to populate real vectors).
export async function embedMany(texts: string[]): Promise<number[][]> {
  if (isDemo()) return texts.map(() => zeroVec());
  try {
    const res = await openai.embeddings.create({ model: MODEL, input: texts, dimensions: DIM });
    return res.data.map((d) => d.embedding);
  } catch (err) {
    onEmbedError(err);
    return texts.map(() => zeroVec());
  }
}
