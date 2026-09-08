import OpenAI from "openai";
import { isDemo } from "@/lib/demo/mode";
import { getProviderKey } from "@/lib/secrets";

const MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-large";
const DIM = Number(process.env.EMBEDDING_DIM ?? 1024);

const zeroVec = () => new Array(DIM).fill(0);

// Resilience: if the embedding provider is unreachable, out of quota, or has no
// key configured, the system degrades to keyword-only retrieval instead of
// failing. A zero vector makes the semantic (pgvector) leg of hybrid search
// inert, so Reciprocal Rank Fusion falls back to the full-text leg. Set
// EMBEDDINGS_STRICT=1 to turn failures into hard errors instead.
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

// Build (and cache) the OpenAI client for the CURRENTLY resolved key, so a key
// changed in the dashboard is picked up without a redeploy. maxRetries:0 — a
// quota/auth failure won't recover on retry, so fail fast into the fallback.
let cached: { key: string; client: OpenAI } | null = null;
async function client(): Promise<OpenAI | null> {
  const key = await getProviderKey("openai");
  if (!key) return null;
  if (!cached || cached.key !== key) cached = { key, client: new OpenAI({ apiKey: key, maxRetries: 0 }) };
  return cached.client;
}

// Embed a single string, truncated to DIM dimensions. Demo/no-key/outage -> zero vector.
export async function embed(text: string): Promise<number[]> {
  if (isDemo()) return zeroVec();
  const c = await client();
  if (!c) {
    onEmbedError(new Error("no OpenAI key configured"));
    return zeroVec();
  }
  try {
    const res = await c.embeddings.create({ model: MODEL, input: text, dimensions: DIM });
    return res.data[0].embedding;
  } catch (err) {
    onEmbedError(err);
    return zeroVec();
  }
}

// Batch embed (ingestion). Demo/no-key/outage -> zero vectors (rows stay
// full-text searchable; re-ingest once a key is set to populate real vectors).
export async function embedMany(texts: string[]): Promise<number[][]> {
  if (isDemo()) return texts.map(() => zeroVec());
  const c = await client();
  if (!c) {
    onEmbedError(new Error("no OpenAI key configured"));
    return texts.map(() => zeroVec());
  }
  try {
    const res = await c.embeddings.create({ model: MODEL, input: texts, dimensions: DIM });
    return res.data.map((d) => d.embedding);
  } catch (err) {
    onEmbedError(err);
    return texts.map(() => zeroVec());
  }
}
