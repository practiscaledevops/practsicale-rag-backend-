// POST /api/admin/sources/[id]/backfill-transcripts — back-fill transcript
// documents for every past call this source can return.
//
// Admin-only (dashboard session). Loads the data source scoped to the admin's
// org, pages ALL reports with include_transcript=true (ignoring the incremental
// cursor), and ingests a `transcript` document for each call that has one.
// Idempotent — a transcript already stored (by content hash) is skipped.
//
// org_id is resolved SERVER-SIDE from the admin session (never from the request),
// and the source lookup is filtered by that org — a request can only ever back-
// fill a source belonging to the caller's own tenant.

import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
import { backfillTranscripts, type DataSourceRow } from "@/lib/connectors/pull";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 300;
// Leave headroom under maxDuration for finalisation before the function is killed.
const BUDGET_MS = 280_000;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let admin;
  try {
    admin = await requireAdmin("data_sources:write");
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  const { id } = await ctx.params;
  const db = supabaseAdmin();

  const { data: source, error } = await db
    .from("data_sources")
    .select(
      "id, org_id, name, slug, source_type, kind, endpoint_url, http_method, auth_type, auth_secret_ref, headers, query_params, records_path, record_id_field, cursor_field, cursor_param, cursor_value"
    )
    .eq("id", id)
    .eq("org_id", admin.orgId)
    .maybeSingle();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!source) return Response.json({ error: "Data source not found" }, { status: 404 });

  try {
    const result = await backfillTranscripts(source as DataSourceRow, {
      db,
      deadlineAt: Date.now() + BUDGET_MS,
    });
    return Response.json({
      calls: result.calls,
      transcriptsCreated: result.transcriptsCreated,
      transcriptsSkipped: result.transcriptsSkipped,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "back-fill failed";
    return Response.json({ error: message }, { status: 502 });
  }
}
