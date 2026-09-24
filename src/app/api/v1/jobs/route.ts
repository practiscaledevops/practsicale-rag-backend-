// POST /api/v1/jobs — start a background job from a scoped key (the chatbot uses
// this to launch a deep audit and then show its live progress on the chat
// screen). Org comes from the key; the key must be allowed to chat AND to see
// transcripts (a deep audit reads them), else 403.

import { after } from "next/server";
import { resolveContext, AuthError } from "@/lib/auth/context";
import { supabaseAdmin } from "@/lib/supabase";
import { createJob, planJob, drainTasks } from "@/lib/jobs/engine";
import {
  parseCallReviewFilter,
  describeFilter,
  knownConsultants,
  businessDay,
} from "@/lib/call-review";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 300;
const KICK_BUDGET_MS = 240_000;

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

  const body = (await req.json().catch(() => ({}))) as { query?: string };
  if (!body.query) return Response.json({ error: "Provide a `query`." }, { status: 400 });

  const known = await knownConsultants(supabaseAdmin(), ctx.orgId);
  const today = businessDay(new Date().toISOString()) ?? new Date().toISOString().slice(0, 10);
  const filter = parseCallReviewFilter(body.query, { referenceDate: today, knownConsultants: known });
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
    after(() => drainTasks({ orgId: ctx.orgId, deadlineAt: Date.now() + KICK_BUDGET_MS }));
    return Response.json(
      { job: { id: job.id, title: job.title, status: count > 0 ? "running" : "completed", total_tasks: count } },
      { status: 201 }
    );
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Could not start the audit." }, { status: 500 });
  }
}
