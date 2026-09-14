// Smart Route — pick the model tier for a query SERVER-SIDE.
//
// The consumer app may send `model: "smart"` instead of a fixed tier; the Brain
// then chooses fast | recommended | max from the question itself. This keeps
// model choice a BACKEND policy (never the UI's alone): a heuristic classifier,
// so there is no extra LLM round-trip on the hot path and the decision is
// deterministic and testable.
//
// Routing intent:
//   fast         short, simple lookups ("what is X", "list Y") — cheap + instant
//   max          analytical, multi-part, or long asks — deepest reasoning
//   recommended  everything else (the balanced default)

export type Tier = "fast" | "recommended" | "max";

// Analytical / heavy-lift intent → escalate to the strongest tier.
const MAX_SIGNALS =
  /\b(analy[sz]e|analysis|compare|comparison|contrast|evaluate|assess(?:ment)?|strateg(?:y|ic|ies)|trade[- ]?offs?|pros and cons|decision|memo|framework|root cause|deep[- ]?dive|in[- ]?depth|comprehensive|critique|implications?|forecast|roadmap|synthesi[sz]e|reconcile|rationale|second[- ]order|why (?:does|is|are|should)|how should we)\b/i;

// Simple factual lookups → the cheapest, fastest tier.
const FAST_SIGNALS =
  /^(what(?:'s| is| are)|whats|who(?:'s| is)|when(?:'s| is| was)|where(?:'s| is)|which|define|list|show me|how many|how much|is there|are there|do we have|does|did)\b/i;

/**
 * Choose a tier for `query`. Pure and synchronous — safe on the hot path.
 * Falls back to "recommended" for empty/ambiguous input.
 */
export function routeTier(query: string): Tier {
  const q = (query || "").trim();
  if (!q) return "recommended";

  const words = q.split(/\s+/).filter(Boolean).length;
  const questionMarks = (q.match(/\?/g) ?? []).length;
  const multiline = q.includes("\n");

  // Escalate: analytical intent, several questions at once, or a long ask.
  if (MAX_SIGNALS.test(q) || q.length > 320 || questionMarks >= 3 || words > 60) {
    return "max";
  }

  // De-escalate: a short, single, factual lookup with no analytical wording.
  if (words <= 8 && !multiline && questionMarks <= 1 && FAST_SIGNALS.test(q)) {
    return "fast";
  }

  return "recommended";
}
