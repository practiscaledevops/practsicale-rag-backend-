// POST /api/v1/jobs — start a background job from a scoped key (the chatbot uses
// this to launch a deep audit and then show its live progress on the chat
// screen). Org comes from the key; the key must be allowed to chat AND to see
// transcripts (a deep audit reads them), else 403.
//
// Body: { query: string, history?: [{ role: "user"|"assistant"|"system", content, createdAt? }] }
//   `history` (≤12 turns, ≤4000 chars each) lets a follow-up such as "analyse all
//   calls do audit" after "list yesterday consultants calls" resolve to
//   yesterday's calls (a leading "[Conversation summary] …" system turn is the
//   last-resort source). A turn's optional `createdAt` (ISO) anchors its relative
//   dates to the day it was sent. 400 when no usable filter results.

import { z } from "zod";
import { resolveContext, AuthError } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase";
import { createJob, planJob } from "@/lib/jobs/engine";
import { dispatchJob } from "@/lib/jobs/dispatch";
import {
  resolveReviewFilterWithHistory,
  describeFilter,
  knownConsultants,
  businessDay,
} from "@/lib/call-review";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 300;
const KICK_BUDGET_MS = 240_000;

// Bounded so a hostile payload is a 400, never an unbounded parse.
const JobBodySchema = z.object({
  query: z.string().trim().min(1, "Provide a `query`.").max(8000),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.string().max(4000),
        createdAt: z.string().max(64).optional(),
      })
    )
    .max(12)
    .optional(),
});

function canSeeTranscripts(sourceTypes: string[] | null | undefined): boolean {
  return !sourceTypes || sourceTypes.length === 0 || sourceTypes.includes("transcript");
}

export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await resolveContext(req);
  } catch (e) {
    const err = e as AuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }
  if (!ctx.key.capabilities.includes("chat")) {
    return Response.json({ error: "This key cannot start jobs (needs the chat capability)." }, { status: 403 });
  }
  if (!canSeeTranscripts(ctx.key.source_types)) {
    return Response.json({ error: "This key cannot read call transcripts." }, { status: 403 });
  }

  const raw = (await req.json().catch(() => ({}))) as { query?: unknown };
  if (!raw || typeof raw !== "object" || typeof raw.query !== "string" || !raw.query.trim()) {
    return Response.json({ error: "Provide a `query`." }, { status: 400 });
  }
  const parsed = JobBodySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return Response.json(
      { error: `Invalid request body: ${issue?.path.join(".") || "body"} ${issue?.message ?? ""}`.trim() },
      { status: 400 }
    );
  }
  const body = parsed.data;

  const known = await knownConsultants(supabaseAdmin(), ctx.orgId);
  const today = businessDay(new Date().toISOString()) ?? new Date().toISOString().slice(0, 10);
  const filter = resolveReviewFilterWithHistory(body.query, body.history ?? [], { referenceDate: today, knownConsultants: known });
  if (!filter.isReview || (!filter.date && !filter.dateFrom && !filter.consultants?.length && !filter.practiceType)) {
    return Response.json(
      { error: "Not an audit request — name a date, range, consultant, or practice type." },
      { status: 400 }
    );
  }

  try {
    const job = await createJob({
      orgId: ctx.orgId,
      type: "deep_call_audit",
      title: `Deep audit — ${describeFilter(filter)}`,
      params: {
        date: filter.date,
        dateFrom: filter.dateFrom,
        dateTo: filter.dateTo,
        consultants: filter.consultants,
        practiceType: filter.practiceType,
      },
      deadlineMinutes: 180,
    });
    const count = await planJob(job);
    await dispatchJob(job, { budgetMs: KICK_BUDGET_MS });
    return Response.json(
      { job: { id: job.id, title: job.title, status: count > 0 ? "running" : "completed", total_tasks: count } },
      { status: 201 }
    );
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Could not start the audit." }, { status: 500 });
  }
}
