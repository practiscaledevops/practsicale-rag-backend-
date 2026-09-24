// Generic background-job engine. A job fans out into tasks (handler.plan); a
// worker claims and runs one task at a time (handler.runTask); when all tasks
// finish, the handler aggregates them into a final report (handler.finalize).
//
// The engine is runner-agnostic: a Vercel cron drains a few tasks per minute,
// and a Trigger.dev task can drain continuously for hours. Nothing here depends
// on a single request completing. All writes go through supabaseAdmin (service
// role); routes resolve org server-side and never trust the client for org_id.

import { supabaseAdmin } from "@/lib/supabase";
import { JOB_HANDLERS } from "@/lib/jobs/handlers";

export type JobStatus = "queued" | "running" | "completed" | "partial" | "failed" | "canceled";
export type TaskStatus = "queued" | "running" | "completed" | "failed";

export interface Job {
  id: string;
  org_id: string;
  type: string;
  title: string;
  params: Record<string, unknown>;
  status: JobStatus;
  total_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  result: unknown;
  error: string | null;
  created_by: string | null;
  runner_ref: string | null;
  deadline_at: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface JobTask {
  id: string;
  job_id: string;
  org_id: string;
  idx: number;
  label: string;
  status: TaskStatus;
  input: Record<string, unknown>;
  result: unknown;
  error: string | null;
  attempts: number;
}

export interface PlannedTask {
  label: string;
  input: Record<string, unknown>;
}

/** A job type's behaviour. Register new data-source jobs here (see handlers.ts). */
export interface JobHandler {
  /** Split the job into tasks (each a bounded slice of work). */
  plan(job: Job): Promise<PlannedTask[]>;
  /** Run ONE task; return its structured result (stored on the task row). */
  runTask(job: Job, task: JobTask): Promise<unknown>;
  /** Aggregate finished tasks into the job's final result. */
  finalize(job: Job, tasks: JobTask[]): Promise<{ status: JobStatus; result: unknown }>;
}

const JOB_COLUMNS =
  "id, org_id, type, title, params, status, total_tasks, completed_tasks, failed_tasks, result, error, created_by, runner_ref, deadline_at, created_at, updated_at, finished_at";
const TASK_COLUMNS = "id, job_id, org_id, idx, label, status, input, result, error, attempts";

function handlerFor(type: string): JobHandler {
  const h = JOB_HANDLERS[type];
  if (!h) throw new Error(`no job handler for type '${type}'`);
  return h;
}

/** Create a job row (status 'queued'), before planning its tasks. */
export async function createJob(input: {
  orgId: string;
  type: string;
  title: string;
  params: Record<string, unknown>;
  createdBy?: string | null;
  deadlineMinutes?: number;
}): Promise<Job> {
  const db = supabaseAdmin();
  const deadline_at = input.deadlineMinutes
    ? new Date(Date.now() + input.deadlineMinutes * 60_000).toISOString()
    : null;
  const { data, error } = await db
    .from("jobs")
    .insert({
      org_id: input.orgId,
      type: input.type,
      title: input.title,
      params: input.params,
      created_by: input.createdBy ?? null,
      deadline_at,
    })
    .select(JOB_COLUMNS)
    .single();
  if (error || !data) throw new Error(error?.message ?? "could not create job");
  return data as Job;
}

/** Plan a job: fan out into task rows and mark it running. Returns task count. */
export async function planJob(job: Job): Promise<number> {
  const db = supabaseAdmin();
  const planned = await handlerFor(job.type).plan(job);
  if (planned.length === 0) {
    await db
      .from("jobs")
      .update({ status: "completed", total_tasks: 0, result: { note: "No matching items." }, finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", job.id);
    return 0;
  }
  const rows = planned.map((t, i) => ({ job_id: job.id, org_id: job.org_id, idx: i, label: t.label, input: t.input }));
  const { error } = await db.from("job_tasks").insert(rows);
  if (error) throw new Error(`plan insert failed: ${error.message}`);
  await db
    .from("jobs")
    .update({ status: "running", total_tasks: planned.length, updated_at: new Date().toISOString() })
    .eq("id", job.id);
  return planned.length;
}

/** Optimistically claim one queued task (org-scoped if given), or null. */
async function claimNextTask(orgId?: string): Promise<JobTask | null> {
  const db = supabaseAdmin();
  for (let attempt = 0; attempt < 5; attempt++) {
    let q = db.from("job_tasks").select("id").eq("status", "queued").order("idx", { ascending: true }).limit(1);
    if (orgId) q = q.eq("org_id", orgId);
    const { data: candidates } = await q;
    const id = (candidates?.[0] as { id?: string } | undefined)?.id;
    if (!id) return null;
    // Claim it only if still queued (loser of a race gets 0 rows → retry).
    const { data: claimed } = await db
      .from("job_tasks")
      .update({ status: "running", started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "queued")
      .select(TASK_COLUMNS)
      .maybeSingle();
    if (claimed) return claimed as JobTask;
  }
  return null;
}

async function getJobRow(jobId: string): Promise<Job | null> {
  const db = supabaseAdmin();
  const { data } = await db.from("jobs").select(JOB_COLUMNS).eq("id", jobId).maybeSingle();
  return (data as Job) ?? null;
}

/** Run one claimed task, store its result, bump counters, and finalize if last. */
async function runClaimedTask(task: JobTask): Promise<void> {
  const db = supabaseAdmin();
  const job = await getJobRow(task.job_id);
  if (!job) return;
  try {
    const result = await handlerFor(job.type).runTask(job, task);
    await db
      .from("job_tasks")
      .update({ status: "completed", result: result ?? null, attempts: task.attempts + 1, finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", task.id);
    await bumpAndMaybeFinalize(job.id);
  } catch (e) {
    const message = e instanceof Error ? e.message : "task failed";
    await db
      .from("job_tasks")
      .update({ status: "failed", error: message.slice(0, 2000), attempts: task.attempts + 1, finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", task.id);
    await bumpAndMaybeFinalize(job.id);
  }
}

async function bumpAndMaybeFinalize(jobId: string): Promise<void> {
  const db = supabaseAdmin();
  const job = await getJobRow(jobId);
  if (!job) return;
  // Recompute counters from the task rows rather than incrementing, so parallel
  // workers (Trigger.dev) finishing tasks at the same instant can never lose an
  // update — COUNT is always exact. Also makes finalize fire reliably at 'done'.
  const [completedRes, failedRes] = await Promise.all([
    db.from("job_tasks").select("id", { count: "exact", head: true }).eq("job_id", jobId).eq("status", "completed"),
    db.from("job_tasks").select("id", { count: "exact", head: true }).eq("job_id", jobId).eq("status", "failed"),
  ]);
  const completed = completedRes.count ?? 0;
  const failed = failedRes.count ?? 0;
  const done = completed + failed;
  await db
    .from("jobs")
    .update({ completed_tasks: completed, failed_tasks: failed, updated_at: new Date().toISOString() })
    .eq("id", jobId);

  const total = job.total_tasks;
  if (total > 0 && done >= total && job.status === "running") {
    const { data: taskRows } = await db.from("job_tasks").select(TASK_COLUMNS).eq("job_id", jobId).order("idx");
    const tasks = (taskRows ?? []) as JobTask[];
    try {
      const fresh = (await getJobRow(jobId))!;
      const { status, result } = await handlerFor(job.type).finalize(fresh, tasks);
      await db
        .from("jobs")
        .update({ status, result: result ?? null, finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", jobId)
        .eq("status", "running");
    } catch (e) {
      await db
        .from("jobs")
        .update({ status: "partial", error: e instanceof Error ? e.message.slice(0, 2000) : "finalize failed", finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", jobId)
        .eq("status", "running");
    }
  }
}

/**
 * Drain queued tasks until there are none, the count/deadline is hit, or a job
 * deadline passes. Used by both the cron (short budget) and Trigger.dev (hours).
 * Returns how many tasks it ran.
 */
export async function drainTasks(opts: { orgId?: string; maxTasks?: number; deadlineAt?: number } = {}): Promise<number> {
  const maxTasks = opts.maxTasks ?? 100;
  let ran = 0;
  while (ran < maxTasks) {
    if (opts.deadlineAt && Date.now() > opts.deadlineAt) break;
    const task = await claimNextTask(opts.orgId);
    if (!task) break;
    await runClaimedTask(task);
    ran++;
  }
  return ran;
}

export async function getJobWithTasks(jobId: string, orgId: string): Promise<{ job: Job; tasks: JobTask[] } | null> {
  const db = supabaseAdmin();
  const { data: job } = await db.from("jobs").select(JOB_COLUMNS).eq("id", jobId).eq("org_id", orgId).maybeSingle();
  if (!job) return null;
  const { data: tasks } = await db.from("job_tasks").select(TASK_COLUMNS).eq("job_id", jobId).eq("org_id", orgId).order("idx");
  return { job: job as Job, tasks: (tasks ?? []) as JobTask[] };
}

export async function listJobs(orgId: string, limit = 25): Promise<Job[]> {
  const db = supabaseAdmin();
  const { data } = await db.from("jobs").select(JOB_COLUMNS).eq("org_id", orgId).order("created_at", { ascending: false }).limit(limit);
  return (data ?? []) as Job[];
}
