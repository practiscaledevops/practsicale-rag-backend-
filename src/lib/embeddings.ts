import OpenAI from "openai";
import { isDemo } from "@/lib/demo/mode";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-large";
const DIM = Number(process.env.EMBEDDING_DIM ?? 1024);

const zeroVec = () => new Array(DIM).fill(0);

// Create an embedding for a single string, truncated to DIM dimensions.
// In DEMO MODE returns a zero vector (the fake search ignores the embedding).
export async function embed(text: string): Promise<number[]> {
  if (isDemo()) return zeroVec();
  const res = await openai.embeddings.create({
    model: MODEL,
    input: text,
    dimensions: DIM,
  });
  return res.data[0].embedding;
}

// Batch embed many strings (used during ingestion).
export async function embedMany(texts: string[]): Promise<number[][]> {
  if (isDemo()) return texts.map(() => zeroVec());
  const res = await openai.embeddings.create({
    model: MODEL,
    input: texts,
    dimensions: DIM,
  });
  return res.data.map((d) => d.embedding);
}
