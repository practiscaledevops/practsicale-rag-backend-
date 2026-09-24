// Job handler: "deep_call_audit". Reads EVERY matching call's full transcript
// and produces a structured, per-call QA audit — the job that makes sense for
// hundreds/thousands of calls where one chat answer can't read them all.
//
//   plan     -> find all matching calls, split into batches of ~8 (one task each)
//   runTask  -> load that batch's transcripts, LLM -> structured findings per call
//   finalize -> aggregate every task's findings into a deterministic report
//
// Params (job.params) mirror a CallReviewFilter: { date?, dateFrom?, dateTo?,
// consultants?, practiceType? }. Accurate at scale (bounded per-task context, no
// hallucination — the report is computed from stored structured results).

import { z } from "zod";
import { generateObject } from "ai";
import { supabaseAdmin } from "@/lib/supabase";
import { getModel } from "@/lib/llm";
import { matchingCallDocs, type CallReviewFilter, type ScorecardRow } from "@/lib/call-review";
import type { Job, JobTask, JobHandler, JobStatus, PlannedTask } from "@/lib/jobs/engine";

const BATCH_SIZE = 8;
const MAX_TRANSCRIPT_CHARS = 14_000; // per call, keeps each task's context bounded

// Model tier for the per-batch audit extraction. Defaults to "max" (Opus) to keep
// current quality; set AUDIT_MODEL_TIER=recommended for the ~4-5x cheaper + faster
// Sonnet, which is usually plenty for this structured, transcript-grounded pass.
function auditModelTier(): "fast" | "recommended" | "max" {
  const t = (process.env.AUDIT_MODEL_TIER ?? "").toLowerCase();
  return t === "fast" || t === "recommended" || t === "max" ? t : "max";
}

function paramsToFilter(params: Record<string, unknown>): CallReviewFilter {
  return {
    isReview: true,
    date: typeof params.date === "string" ? params.date : undefined,
    dateFrom: typeof params.dateFrom === "string" ? params.dateFrom : undefined,
    dateTo: typeof params.dateTo === "string" ? params.dateTo : undefined,
    consultants: Array.isArray(params.consultants) ? (params.consultants as string[]) : undefined,
    practiceType: typeof params.practiceType === "string" ? params.practiceType : undefined,
  };
}

/** Load full transcript text for a set of call document_ids, in reading order. */
async function loadTranscripts(orgId: string, docIds: string[]): Promise<Map<string, { text: string; meta: Record<string, unknown> }>> {
  const db = supabaseAdmin();
  const { data } = await db
    .from("chunks")
    .select("content, metadata, document_id, created_at")
    .eq("org_id", orgId)
    .eq("source_type", "transcript")
    .in("document_id", docIds)
    .order("document_id", { ascending: true })
    .order("created_at", { ascending: true });
  const byDoc = new Map<string, { text: string; meta: Record<string, unknown> }>();
  for (const r of (data ?? []) as { content: string; metadata: Record<string, unknown>; document_id: string }[]) {
    const cur = byDoc.get(r.document_id) ?? { text: "", meta: r.metadata ?? {} };
    if (cur.text.length < MAX_TRANSCRIPT_CHARS) cur.text += (cur.text ? "\n" : "") + (r.content ?? "");
    byDoc.set(r.document_id, cur);
  }
  return byDoc;
}

const callFinding = z.object({
  prospect: z.string(),
  consultant: z.string(),
  score: z.number().nullable(),
  summary: z.string().describe("1-2 sentences: what actually happened on the call"),
  strengths: z.array(z.string()).describe("what the consultant did well, grounded in the transcript"),
  gaps: z.array(z.string()).describe("what broke down, grounded in the transcript"),
  coaching: z.string().describe("the single most important concrete next move for this consultant"),
});
const batchResult = z.object({ calls: z.array(callFinding) });

export const deepCallAuditHandler: JobHandler = {
  async plan(job: Job): Promise<PlannedTask[]> {
    const db = supabaseAdmin();
    const { docIds, scorecard } = await matchingCallDocs(db, job.org_id, paramsToFilter(job.params));
    const cardByDoc = new Map<string, ScorecardRow>();
    docIds.forEach((id, i) => cardByDoc.set(id, scorecard[i]));
    const tasks: PlannedTask[] = [];
    for (let i = 0; i < docIds.length; i += BATCH_SIZE) {
      const batch = docIds.slice(i, i + BATCH_SIZE);
      const cards = batch.map((id) => cardByDoc.get(id)).filter(Boolean) as ScorecardRow[];
      const label = `Batch ${tasks.length + 1}: ${batch.length} call${batch.length === 1 ? "" : "s"}` +
        (cards[0] ? ` (${cards[0].consultant}${cards.length > 1 ? " +" : ""})` : "");
      tasks.push({ label, input: { documentIds: batch, cards } });
    }
    return tasks;
  },

  async runTask(job: Job, task: JobTask): Promise<unknown> {
    const docIds = (task.input.documentIds as string[]) ?? [];
    if (docIds.length === 0) return { calls: [] };
    const transcripts = await loadTranscripts(job.org_id, docIds);
    const blocks: string[] = [];
    for (const id of docIds) {
      const t = transcripts.get(id);
      if (!t) continue;
      const m = t.meta;
      blocks.push(
        `=== CALL: ${m.consultant_name ?? "?"} -> ${m.prospect_name ?? "?"} | ${m.practice_type ?? "?"} | score ${m.overall_score ?? "?"}/100 | ${m.call_duration_minutes ?? "?"} min ===\n${t.text || "(transcript body not available)"}`
      );
    }
    const model = await getModel(auditModelTier());
    const { object } = await generateObject({
      model,
      schema: batchResult,
      system:
        "You are a rigorous sales-call QA auditor. For EACH call transcript, produce a structured audit grounded ONLY in that transcript. Quote or paraphrase real moments; never invent. If a transcript body is missing, say so in the summary and leave strengths/gaps light. Be specific and blunt.",
      prompt: `Audit each of these ${blocks.length} call transcripts. Return one entry per call.\n\n${blocks.join("\n\n")}`,
    });
    return object;
  },

  async finalize(job: Job, tasks: JobTask[]): Promise<{ status: JobStatus; result: unknown }> {
    type Finding = z.infer<typeof callFinding>;
    const calls: Finding[] = [];
    for (const t of tasks) {
      const r = t.result as { calls?: Finding[] } | null;
      if (r?.calls) calls.push(...r.calls);
    }
    const byConsultant = new Map<string, { calls: number; scoreSum: number; scored: number; gaps: string[]; coaching: string[] }>();
    for (const c of calls) {
      const key = c.consultant || "Unknown";
      const agg = byConsultant.get(key) ?? { calls: 0, scoreSum: 0, scored: 0, gaps: [], coaching: [] };
      agg.calls++;
      if (typeof c.score === "number") { agg.scoreSum += c.score; agg.scored++; }
      agg.gaps.push(...c.gaps.slice(0, 2));
      if (c.coaching) agg.coaching.push(c.coaching);
      byConsultant.set(key, agg);
    }
    const consultants = [...byConsultant.entries()].map(([name, a]) => ({
      name,
      calls: a.calls,
      avgScore: a.scored ? Math.round((a.scoreSum / a.scored) * 10) / 10 : null,
      topGaps: [...new Set(a.gaps)].slice(0, 5),
      coaching: [...new Set(a.coaching)].slice(0, 3),
    })).sort((x, y) => y.calls - x.calls);

    const failed = tasks.filter((t) => t.status === "failed").length;
    const result = {
      generatedAt: new Date().toISOString(),
      totalCalls: calls.length,
      consultants,
      calls, // full per-call findings
      tasksFailed: failed,
    };
    return { status: failed > 0 ? "partial" : "completed", result };
  },
};
