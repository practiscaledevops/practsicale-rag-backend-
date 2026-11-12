import type { FaithfulnessVerdict } from "@/lib/faithfulness";
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
