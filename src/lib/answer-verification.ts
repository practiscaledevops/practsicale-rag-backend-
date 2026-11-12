import type { FaithfulnessVerdict } from "@/lib/faithfulness";

/** One correction attempt, followed by a fresh check. Never release the rejected draft. */
export async function verifyAndRepairAnswer(input: {
  text: string;
  verify: (text: string) => Promise<FaithfulnessVerdict | null>;
  fabricated: (text: string) => string[];
  canRepair: () => boolean;
  repair: (text: string, unsupported: string[], fabricated: string[]) => Promise<string | null>;
}) {
  let text = input.text;
  let verdict = await input.verify(text).catch(() => null);
  let fabricated = input.fabricated(text);
  let repaired = false;
  const firstUsage = verdict?.usage;
  if ((fabricated.length || (verdict?.checked && !verdict.grounded)) && input.canRepair()) {
    const candidate = await input.repair(text, verdict?.unsupported ?? [], fabricated).catch(() => null);
    if (candidate?.trim()) {
      text = candidate;
      fabricated = input.fabricated(text);
      verdict = await input.verify(text).catch(() => null);
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
