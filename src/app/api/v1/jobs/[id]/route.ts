// GET /api/v1/jobs/[id] — a job's live progress for the scoped key's org (the
// chatbot polls this to render the on-chat progress card). Light payload.

import { resolveContext, AuthError } from "@/lib/auth/context";
import { getJobWithTasks } from "@/lib/jobs/engine";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx2: { params: Promise<{ id: string }> }) {
  let ctx;
  try {
    ctx = await resolveContext(req);
  } catch (e) {
    const err = e as AuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }
  const { id } = await ctx2.params;
  const data = await getJobWithTasks(id, ctx.orgId);
  if (!data) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({
    job: {
      id: data.job.id,
      title: data.job.title,
      status: data.job.status,
      total_tasks: data.job.total_tasks,
      completed_tasks: data.job.completed_tasks,
      failed_tasks: data.job.failed_tasks,
      result: data.job.result,
      finished_at: data.job.finished_at,
    },
    tasks: data.tasks.map((t) => ({ idx: t.idx, label: t.label, status: t.status })),
  });
}
