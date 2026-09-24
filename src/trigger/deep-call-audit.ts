// Trigger.dev tasks that run the background job queue on dedicated machines.
//
// The Brain's job engine is runner-agnostic: `drainTasks` claims queued tasks
// (atomically — parallel drainers never collide) and finalizes the job when the
// last one lands. These tasks are just a long-lived, parallel runner for that
// same queue, for audits too big for a serverless request:
//
//   deep-call-audit (orchestrator)  fan the job across N workers, then confirm it
//   audit-worker    (worker)        drain queued tasks until none remain / deadline
//
// The Next.js app never imports this file; it triggers `deep-call-audit` by id
// (see src/lib/jobs/dispatch.ts) only when TRIGGER_SECRET_KEY is set. Env vars
// the job subgraph needs (Supabase URL + service role key, model/provider keys)
// must be set in the Trigger.dev dashboard — see docs/JOBS.md.

import { task } from "@trigger.dev/sdk/v3";
import { drainTasks, getJobWithTasks } from "@/lib/jobs/engine";

// Trigger.dev machine time budget (seconds). A 3-hour ceiling for the largest
// audits; individual tasks finish long before this.
const MAX_DURATION_S = 3 * 60 * 60;
// Leave headroom under the machine limit so a final finalize write still lands.
const DRAIN_HEADROOM_MS = 120_000;
// One worker per this many batches (tasks), so small jobs stay single-agent and
// big ones parallelise. Capped by MAX_WORKERS.
const BATCHES_PER_WORKER = 6;
const MAX_WORKERS = 8;

interface JobPayload {
  jobId: string;
  orgId: string;
}

/**
 * One drain agent: claims and runs queued tasks for this org until the queue is
 * empty or the deadline passes. Safe to run many in parallel — claims are atomic.
 */
export const auditWorker = task({
  id: "audit-worker",
  maxDuration: MAX_DURATION_S,
  run: async (payload: { orgId: string; deadlineAt: number }) => {
    const ran = await drainTasks({
      orgId: payload.orgId,
      maxTasks: 100_000,
      deadlineAt: payload.deadlineAt,
    });
    return { ran };
  },
});

/**
 * Orchestrate a planned job: size the agent pool to the work, fan out parallel
 * workers (or drain inline for a small job), then report the finalized status.
 * Finalization itself happens in the engine when the last task completes.
 */
export const deepCallAudit = task({
  id: "deep-call-audit",
  maxDuration: MAX_DURATION_S,
  run: async (payload: JobPayload) => {
    const before = await getJobWithTasks(payload.jobId, payload.orgId);
    const total = before?.job.total_tasks ?? 0;
    const deadlineAt = Date.now() + MAX_DURATION_S * 1000 - DRAIN_HEADROOM_MS;

    if (total === 0) {
      return { status: before?.job.status ?? "unknown", totalTasks: 0, workers: 0 };
    }

    const workers = Math.max(1, Math.min(MAX_WORKERS, Math.ceil(total / BATCHES_PER_WORKER)));

    if (workers === 1) {
      await drainTasks({ orgId: payload.orgId, maxTasks: 100_000, deadlineAt });
    } else {
      // Fan out N agents that compete for the same queue; wait for all to drain.
      await auditWorker.batchTriggerAndWait(
        Array.from({ length: workers }, () => ({
          payload: { orgId: payload.orgId, deadlineAt },
        }))
      );
    }

    const after = await getJobWithTasks(payload.jobId, payload.orgId);
    return {
      status: after?.job.status ?? "unknown",
      totalTasks: total,
      completed: after?.job.completed_tasks ?? 0,
      failed: after?.job.failed_tasks ?? 0,
      workers,
    };
  },
});
