// /api/admin/jobs — background jobs (create + list). Admin-only, org-scoped.
//
//   POST { query }            — turn a natural-language audit request into a
//                               deep_call_audit job (parses date/consultant/
//                               practice), plans its tasks, and starts draining.
//   POST { type, title, params } — create a typed job directly.
//   GET                        — list this org's recent jobs.

import { after } from "next/server";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
import { supabaseAdmin } from "@/lib/supabase";
import { createJob, planJob, drainTasks } from "@/lib/jobs/engine";
import { JOB_HANDLERS } from "@/lib/jobs/handlers";
import { listJobs } from "@/lib/jobs/engine";
import {
  parseCallReviewFilter,
  describeFilter,
  knownConsultants,
  businessDay,
} from "@/lib/call-review";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 300;
// Kick off some work in the request's background so the job starts immediately
// (the cron + Trigger.dev keep draining the rest). Bounded under maxDuration.
const KICK_BUDGET_MS = 240_000;

export async function GET() {
  let admin;
  try {
    admin = await requireAdmin("documents:read");
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }
  return Response.json({ jobs: await listJobs(admin.orgId) });
}

export async function POST(req: Request) {
  let admin;
  try {
    admin = await requireAdmin("documents:write");
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    query?: string;
    type?: string;
    title?: string;
    params?: Record<string, unknown>;
  };

  let type = body.type;
  let title = body.title;
  let params = body.params ?? {};

  // Natural-language path: "deep audit of all this month's James calls" -> a
  // deep_call_audit job whose params are the resolved call filter.
  if (body.query && !type) {
    const known = await knownConsultants(supabaseAdmin(), admin.orgId);
    const today = businessDay(new Date().toISOString()) ?? new Date().toISOString().slice(0, 10);
    const filter = parseCallReviewFilter(body.query, { referenceDate: today, knownConsultants: known });
    if (!filter.isReview || (!filter.date && !filter.dateFrom && !filter.consultants?.length && !filter.practiceType)) {
      return Response.json(
        { error: "Not an audit request — name a date, date range, consultant, or practice type (e.g. 'deep audit of this month's calls')." },
        { status: 400 }
      );
    }
    type = "deep_call_audit";
    title = title ?? `Deep audit — ${describeFilter(filter)}`;
    params = {
      date: filter.date,
      dateFrom: filter.dateFrom,
      dateTo: filter.dateTo,
      consultants: filter.consultants,
      practiceType: filter.practiceType,
    };
  }

  if (!type || !JOB_HANDLERS[type]) {
    return Response.json({ error: `Unknown job type '${type ?? ""}'.` }, { status: 400 });
  }

  try {
    const job = await createJob({
      orgId: admin.orgId,
      type,
      title: title ?? type,
      params,
      createdBy: (admin as { userId?: string }).userId ?? null,
      deadlineMinutes: 180,
    });
    const count = await planJob(job);
    // Start draining in the request's background so progress appears at once.
    after(() => drainTasks({ orgId: admin.orgId, deadlineAt: Date.now() + KICK_BUDGET_MS }));
    return Response.json({ job: { ...job, total_tasks: count, status: count > 0 ? "running" : "completed" } }, { status: 201 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Could not start the job." }, { status: 500 });
  }
}
