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

// Ingestion embedding: batches of ≤100 inputs per request (a whole document in
// one call trips the provider's per-request caps), and a failed batch yields
// `null` per chunk — NOT a zero vector. A zero vector persisted as "embedded"
// is invisible to re-indexing and silently dead on the semantic leg; a null
// embedding keeps the chunk full-text searchable and lets Reprocess find it.
const EMBED_BATCH = 100;
// UTF-8 byte length is a conservative upper bound for byte-pair token count.
// This avoids a tokenizer dependency and handles non-English/long parent chunks
// without truncating stored evidence. Stay below 8192/input and 300k/request.
const EMBED_INPUT_BYTES = 6000;
const EMBED_REQUEST_BYTES = 240_000;
export function splitEmbeddingInput(text: string): string[] {
  if (Buffer.byteLength(text, "utf8") <= EMBED_INPUT_BYTES) return [text];
  const parts: string[] = [];
  let part = "", bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > EMBED_INPUT_BYTES) { parts.push(part); part = ""; bytes = 0; }
    part += character; bytes += size;
  }
  if (part) parts.push(part);
  return parts;
}
export async function embedForIngest(texts: string[]): Promise<(number[] | null)[]> {
  if (isDemo() || texts.length === 0) return texts.map(() => null);
  const c = await client();
  if (!c) {
    onEmbedError(new Error("no OpenAI key configured"));
    return texts.map(() => null);
  }
  const groups = texts.map(splitEmbeddingInput);
  const inputs = groups.flat();
  const vectors: (number[] | null)[] = inputs.map(() => null);
  for (let i = 0; i < inputs.length;) {
    let end = i, bytes = 0;
    while (end < inputs.length && end - i < EMBED_BATCH && bytes + Buffer.byteLength(inputs[end], "utf8") <= EMBED_REQUEST_BYTES) {
      bytes += Buffer.byteLength(inputs[end], "utf8"); end++;
    }
    const batch = inputs.slice(i, end);
    try {
      const res = await c.embeddings.create({ model: MODEL, input: batch, dimensions: DIM });
      const ordered = [...res.data].sort((a, b) => a.index - b.index);
      if (ordered.length !== batch.length || ordered.some((d, j) => d.index !== j || d.embedding.length !== DIM || d.embedding.some(n => !Number.isFinite(n)) || d.embedding.every(n => n === 0))) throw new Error("Embedding provider returned an incomplete or invalid vector set");
      for (let j = 0; j < ordered.length; j++) vectors[i + j] = ordered[j].embedding;
    } catch (err) {
      onEmbedError(err);
    }
    i = end;
  }
  let offset = 0;
  return groups.map(parts => {
    const group = vectors.slice(offset, offset + parts.length); offset += parts.length;
    if (group.some(v => !v)) return null;
    if (group.length === 1) return group[0];
    // Length-weighted pooling retains contributions from the ENTIRE long input.
    // Normalize the pooled vector for cosine/dot-product retrieval.
    const pooled = new Array<number>(DIM).fill(0);
    group.forEach((v, i) => { const weight = Buffer.byteLength(parts[i], "utf8"); v!.forEach((n, j) => pooled[j] += n * weight); });
    const norm = Math.hypot(...pooled);
    if (!norm) { onEmbedError(new Error("Long-input embedding has zero norm")); return null; }
    return pooled.map(n => n / norm);
  });
}

// Batch embed (query-time helpers / object embeddings). Demo/no-key/outage ->
// zero vectors, which make the semantic leg inert so RRF falls back to full-text.
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
