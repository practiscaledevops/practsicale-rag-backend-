// Structured LLM output — one helper the compiler, intent classifier, dedup
// judge and learning detector all use. Tries the provider's native structured
// output (tool/JSON mode via `generateObject`), then falls back to plain JSON
// text + zod validation, and finally returns null so every caller can degrade
// gracefully (demo mode, no key, provider outage, a model that rejects the
// schema). Never throws.

import { generateObject, generateText } from "ai";
import type { z } from "zod";
import { getModel } from "@/lib/llm";
import { generationParams } from "@/lib/models-catalog";
import { isDemo } from "@/lib/demo/mode";

export interface StructuredOptions<T> {
  /** Tier alias or concrete model id (default "recommended"). */
  tier?: string;
  system: string;
  prompt: string;
  /** Output-typed: `T` is the parsed (post-default) shape. */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  maxTokens?: number;
  temperature?: number;
}

export interface StructuredResult<T> {
  object: T;
  model: string;
  /** "native" = generateObject; "json" = text fallback parsed + validated. */
  via: "native" | "json";
  durationMs: number;
}

/** Pull the first JSON object/array out of a text blob (tolerates code fences and prose). */
export function extractJson(text: string): unknown {
  const t = (text || "").trim();
  if (!t) return null;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const body = fence ? fence[1].trim() : t;
  try {
    return JSON.parse(body);
  } catch {
    /* fall through */
  }
  // Find the outermost {...} or [...]
  const starts = [body.indexOf("{"), body.indexOf("[")].filter((i) => i >= 0);
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const open = body[start];
  const close = open === "{" ? "}" : "]";
  const end = body.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function structured<T>(opts: StructuredOptions<T>): Promise<StructuredResult<T> | null> {
  if (isDemo()) return null;
  const started = Date.now();
  let m;
  try {
    m = await getModel(opts.tier ?? "recommended");
  } catch {
    return null;
  }
  const params = generationParams(m.modelId, {
    temperature: opts.temperature ?? 0,
    maxTokens: opts.maxTokens ?? 2048,
  });

  // 1. Native structured output.
  try {
    const { object } = await generateObject({
      model: m,
      schema: opts.schema,
      system: opts.system,
      prompt: opts.prompt,
      ...params,
    });
    return { object, model: m.modelId, via: "native", durationMs: Date.now() - started };
  } catch {
    /* fall through to the JSON-text path */
  }

  // 2. Plain JSON text, validated against the schema.
  try {
    const { text } = await generateText({
      model: m,
      system:
        `${opts.system}\n\nRespond with ONLY a single JSON value that matches the required schema exactly. ` +
        `No prose before or after, no markdown code fences, no comments.`,
      prompt: opts.prompt,
      ...params,
    });
    const parsed = opts.schema.safeParse(extractJson(text));
    if (parsed.success) {
      return { object: parsed.data, model: m.modelId, via: "json", durationMs: Date.now() - started };
    }
  } catch {
    /* give up */
  }
  return null;
}
