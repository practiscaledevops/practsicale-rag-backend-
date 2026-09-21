// Learning detection — the Brain notices Organizational Learning inside normal
// work ("we tried five follow-ups and show-up rate improved") and offers to save
// it, with the missing evidence listed, instead of silently believing it.
//
// Cheap by design: a keyword pre-filter decides whether the (fast-tier) model
// runs at all, so ordinary questions cost nothing extra. Never throws.

import { z } from "zod";
import { structured } from "@/lib/structured";

export interface LearningCandidate {
  kind: "decision" | "implementation" | "experiment" | "result" | "learning";
  title: string;
  change: string;
  observedResult: string | null;
  department: string | null;
  relatedRefs: string[];
  missingEvidence: string[];
  confidence: number;
}

const LearningSchema = z.object({
  is_candidate: z.boolean(),
  kind: z.enum(["decision", "implementation", "experiment", "result", "learning"]).optional(),
  title: z.string().default(""),
  change: z.string().default(""),
  observed_result: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  related_refs: z.array(z.string()).default([]),
  missing_evidence: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0),
});

const SIGNAL =
  /\b(we (tried|changed|decided|implemented|rolled out|switched|moved|reduced|increased|started|stopped|removed|added|tested|ran)|we('re| are) (going to|testing|trying)|(went|dropped|fell|rose|improved|increased|decreased|jumped) (from|by|to)|show[- ]?up rate|close rate|after we|since we|result(s)? (was|were|show)|it worked|didn'?t work|didn't work|lesson|learned that|turned out)\b/i;

/** Heuristic pre-filter: only messages that read like a change/result are worth a model call. */
export function looksLikeLearning(message: string): boolean {
  const m = (message || "").trim();
  if (m.length < 40) return false;
  if (m.split(/\s+/).length < 8) return false;
  if (/\?\s*$/.test(m) && !/\b(we|our)\b/i.test(m)) return false;
  return SIGNAL.test(m);
}

/**
 * Detect a learning candidate in the latest user message (+ a little history).
 * `availableRefs` = refs of the knowledge objects retrieved for this turn, so
 * related playbooks can be linked without guessing.
 */
export async function detectLearning(opts: {
  message: string;
  history?: { role: string; content: string }[];
  availableRefs?: { ref: string; name: string }[];
  systemPrompt: string;
  tier?: string;
}): Promise<LearningCandidate | null> {
  if (!looksLikeLearning(opts.message)) return null;
  const recent = (opts.history ?? [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-4)
    .map((m) => `${m.role}: ${m.content.slice(0, 800)}`)
    .join("\n");
  const refs = (opts.availableRefs ?? []).slice(0, 12).map((r) => `${r.ref} — ${r.name}`).join("\n");
  try {
    const res = await structured({
      tier: opts.tier ?? "fast",
      system: opts.systemPrompt,
      prompt: `${recent ? `Recent conversation:\n${recent}\n\n` : ""}Latest user message:\n${opts.message}\n\n${refs ? `Knowledge objects in play (refs you may link):\n${refs}\n\n` : ""}Is there a concrete organizational learning here?`,
      schema: LearningSchema,
      maxTokens: 700,
    });
    if (!res) return null;
    const o = res.object;
    const kind = o.kind;
    if (!o.is_candidate || o.confidence < 0.55 || !kind) return null;
    return {
      kind,
      title: o.title || o.change.slice(0, 80) || "Untitled learning",
      change: o.change,
      observedResult: o.observed_result ?? null,
      department: o.department ?? null,
      relatedRefs: (o.related_refs ?? []).map((r) => r.trim().toUpperCase()).filter(Boolean),
      missingEvidence: (o.missing_evidence ?? []).slice(0, 8),
      confidence: o.confidence,
    };
  } catch {
    return null;
  }
}
