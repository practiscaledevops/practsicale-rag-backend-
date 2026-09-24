// GET /api/admin/jobs/[id] — one job's progress + task board. Admin-only,
// org-scoped. Light payload (task labels/status, not their full results) so the
// dashboard and the chat progress card can poll it cheaply; the aggregated
// report lives on job.result when the job finishes.

import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
import { getJobWithTasks } from "@/lib/jobs/engine";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let admin;
  try {
    admin = await requireAdmin("documents:read");
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }
  const { id } = await ctx.params;
  const data = await getJobWithTasks(id, admin.orgId);
  if (!data) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({
    job: {
      id: data.job.id,
      type: data.job.type,
      title: data.job.title,
      status: data.job.status,
      total_tasks: data.job.total_tasks,
      completed_tasks: data.job.completed_tasks,
      failed_tasks: data.job.failed_tasks,
      result: data.job.result,
      error: data.job.error,
      created_at: data.job.created_at,
      finished_at: data.job.finished_at,
    },
    tasks: data.tasks.map((t) => ({ id: t.id, idx: t.idx, label: t.label, status: t.status })),
  });
}
