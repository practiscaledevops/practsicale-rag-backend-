// Kick a planned job onto a runner.
//
// Trigger.dev when configured (TRIGGER_SECRET_KEY set + the tasks deployed): the
// job runs on dedicated machines with no serverless timeout and fans out into
// parallel agents — the path for hundreds/thousands of calls. Otherwise the
// serverless floor: drain some tasks in the request's background (so progress
// shows immediately) and let the Vercel cron finish the rest.
//
// Either way the SAME queue and the SAME engine (drainTasks) do the work, so the
// two runners are interchangeable and the cron is always a safety net.

import { after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { drainTasks } from "@/lib/jobs/engine";

export type JobRunner = "trigger.dev" | "vercel";

/** The Trigger.dev task id that orchestrates a deep audit (see src/trigger). */
const TRIGGER_TASK_ID = "deep-call-audit";

export async function dispatchJob(
  job: { id: string; org_id: string },
  opts: { budgetMs: number }
): Promise<{ runner: JobRunner; ref?: string }> {
  if (process.env.TRIGGER_SECRET_KEY) {
    try {
      // Dynamic import so the SDK never lands in the serverless route bundle when
      // Trigger.dev isn't in use.
      const { tasks } = await import("@trigger.dev/sdk/v3");
      const handle = await tasks.trigger(TRIGGER_TASK_ID, { jobId: job.id, orgId: job.org_id });
      await supabaseAdmin()
        .from("jobs")
        .update({ runner_ref: handle.id, updated_at: new Date().toISOString() })
        .eq("id", job.id);
      return { runner: "trigger.dev", ref: handle.id };
    } catch {
      // Trigger.dev unreachable / task not deployed yet — fall through to the
      // serverless drain so the job still runs.
    }
  }
  after(() => drainTasks({ orgId: job.org_id, deadlineAt: Date.now() + opts.budgetMs }));
  return { runner: "vercel" };
}
