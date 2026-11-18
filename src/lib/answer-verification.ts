import { validateCitations, type FaithfulnessVerdict } from "@/lib/faithfulness";
import type { RetrievedChunk } from "@/lib/retrieval";

const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

/** Only an explicitly requested, standalone quote is eligible for an exact source check. */
export function matchesRequestedVerbatimQuote(question: string, answer: string, chunks: readonly RetrievedChunk[]): boolean {
  if (!/^(?:please\s+)?quote\b/i.test(question.trim()) || !/\b(?:exactly|verbatim|word for word)\b/i.test(question)) return false;
  const match = /^> ([^\r\n<>\[\]]{15,1000}) \[[A-Za-z0-9_-]+\]$/.exec(answer.trim());
  if (!match) return false;
  const { valid, fabricated } = validateCitations(answer, chunks.map(chunk => chunk.id));
  if (valid.length !== 1 || fabricated.length) return false;
  const source = chunks.find(chunk => chunk.id === valid[0] && chunk.source_type === "document");
  if (!source) return false;
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ");
  const quote = normalize(match[1]);
  // A whole sentence keeps any negation or qualification within that sentence.
  // A direct quotation can also faithfully reproduce the entire source chunk.
  return normalize(source.content) === quote ||
    Array.from(sentences.segment(source.content)).some(({ segment }) => normalize(segment) === quote);
}

/** One correction attempt, followed by a fresh check. Never release the rejected draft. */
export async function verifyAndRepairAnswer(input: {
  text: string;
  verify: (text: string) => Promise<FaithfulnessVerdict | null>;
  fabricated: (text: string) => string[];
  canRepair: () => boolean;
  repair: (text: string, unsupported: string[], fabricated: string[]) => Promise<string | null>;
}) {
  let text = input.text;
  let fabricated = input.fabricated(text);
  let verdict = fabricated.length ? null : await input.verify(text).catch(() => null);
  let repaired = false;
  const firstUsage = verdict?.usage;
  if ((fabricated.length || (verdict?.checked && !verdict.grounded)) && input.canRepair()) {
    const candidate = await input.repair(text, verdict?.unsupported ?? [], fabricated).catch(() => null);
    if (candidate?.trim() && candidate.trim() !== text.trim()) {
      text = candidate;
      fabricated = input.fabricated(text);
      verdict = fabricated.length ? null : await input.verify(text).catch(() => null);
      if (firstUsage) {
        verdict ??= {checked:false,grounded:false,unsupported:[]};
        const next = verdict.usage;
        verdict = { ...verdict, usage: { ...firstUsage,
          inputTokens: firstUsage.inputTokens + (next?.inputTokens ?? 0),
          outputTokens: firstUsage.outputTokens + (next?.outputTokens ?? 0),
          estimatedCostUsd: firstUsage.estimatedCostUsd + (next?.estimatedCostUsd ?? 0),
        } };
      }
      repaired = true;
    }
  }
  return { ...verifiedFactualAnswer(text, verdict, fabricated), verdict, repaired };
}
/** A skipped judge and a fabricated citation cannot certify company facts. */
export function verifiedFactualAnswer(text: string, verdict: FaithfulnessVerdict | null, fabricatedCitations: string[]) {
  if (fabricatedCitations.length || (verdict?.checked && !verdict.grounded)) return {
    text: "I couldn't verify the generated answer against the available company records, so I have withheld it. Please narrow the question to a specific call, client, period or document so I can check the evidence again.",
    verified: false, label: "Unsupported answer withheld",
  };
  if (!verdict?.checked) return {
    text: "The evidence verification step is temporarily unavailable, so I couldn't confirm this answer. Please retry. This does not mean the requested information is absent from your records.",
    verified: false, label: "Verification unavailable; answer withheld",
  };
  return { text, verified: true, label: "Checked against supplied evidence" };
}
