// Faithfulness / grounding verification + citation validation.
//
// This is the anti-hallucination guard that runs AFTER generation. It does two
// cheap, high-value things:
//   1. validateCitations() — parse the [chunk-id] citations the model emitted and
//      keep only those that point at chunks actually retrieved. Fabricated ids are
//      dropped; the set of real citations is returned for the UI/consumer.
//   2. checkFaithfulness() — ask a cheap model whether every claim in the answer
//      is supported by the context. Returns a verdict the caller can surface (or
//      use to trigger a refusal / regeneration).
//
// Graceful: demo mode or any error yields a permissive verdict, so verification
// never blocks a response — it annotates it.

import { generateText } from "ai";
import { getModel } from "@/lib/llm";
import { generationParams } from "@/lib/models-catalog";
import { isDemo } from "@/lib/demo/mode";

export interface FaithfulnessVerdict {
  grounded: boolean;
  unsupported: string[];
  /** true when the check actually ran (false ⇒ skipped/failed, verdict is permissive) */
  checked: boolean;
}

/** All [id] tokens in the answer, de-duplicated. */
export function extractCitationIds(answer: string): string[] {
  const ids = new Set<string>();
  // chunk ids are uuids or short slugs; accept [word-ish] tokens up to 64 chars.
  const re = /\[([A-Za-z0-9][A-Za-z0-9_-]{0,63})\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) ids.add(m[1]);
  return [...ids];
}

/**
 * Keep only citations that point at a retrieved chunk. Returns the valid ids and
 * any fabricated ones (cited but never retrieved) so the caller can flag them.
 */
export function validateCitations(
  answer: string,
  retrievedIds: string[]
): { valid: string[]; fabricated: string[] } {
  const allowed = new Set(retrievedIds);
  const cited = extractCitationIds(answer);
  const valid: string[] = [];
  const fabricated: string[] = [];
  for (const id of cited) {
    if (allowed.has(id)) {
      valid.push(id);
      continue;
    }
    // Long answers shorten uuids to their first 8+ hex chars ([018d99c0]); a
    // prefix that identifies exactly one retrieved chunk is that chunk's citation.
    const lower = id.toLowerCase();
    const prefixed = /^[0-9a-f]{8,}$/.test(lower) ? retrievedIds.filter((r) => r.toLowerCase().startsWith(lower)) : [];
    if (prefixed.length === 1) valid.push(prefixed[0]);
    else fabricated.push(id);
  }
  return { valid: [...new Set(valid)], fabricated };
}

/**
 * Verify the answer is supported by the context. Cheap model, strict JSON.
 * @param systemPrompt the active `faithfulness` prompt (from the DB or default)
 */
export async function checkFaithfulness(
  context: string,
  answer: string,
  systemPrompt: string,
  tier: "fast" | "recommended" | "max" = "fast"
): Promise<FaithfulnessVerdict> {
  const permissive: FaithfulnessVerdict = { grounded: true, unsupported: [], checked: false };
  if (isDemo() || !answer.trim() || !context.trim()) return permissive;

  try {
    const m = await getModel(tier);
    const { text } = await generateText({
      model: m,
      system: systemPrompt,
      prompt: `CONTEXT:\n${context}\n\nANSWER:\n${answer}\n\nJSON verdict:`,
      ...generationParams(m.modelId, { temperature: 0, maxTokens: 300 }),
    });
    const parsed = safeParseVerdict(text);
    if (!parsed) return permissive;
    return { grounded: parsed.grounded, unsupported: parsed.unsupported, checked: true };
  } catch {
    return permissive;
  }
}

function safeParseVerdict(
  text: string
): { grounded: boolean; unsupported: string[] } | null {
  // Tolerate models that wrap JSON in prose or code fences.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as {
      grounded?: unknown;
      unsupported?: unknown;
    };
    const grounded = obj.grounded !== false; // default to grounded unless explicitly false
    const unsupported = Array.isArray(obj.unsupported)
      ? obj.unsupported.filter((x): x is string => typeof x === "string").slice(0, 20)
      : [];
    return { grounded, unsupported };
  } catch {
    return null;
  }
}
