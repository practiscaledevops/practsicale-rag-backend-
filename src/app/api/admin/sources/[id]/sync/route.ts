// POST /api/admin/sources/[id]/sync — trigger a pull sync for one data source.
//
// Admin-only (dashboard session). Loads the data source scoped to the admin's
// org, runs the pull-connector runner, and returns the sync counts.
//
// org_id is resolved SERVER-SIDE from the admin session (never from the request),
// and the source lookup is filtered by that org — a request can only ever sync a
// source belonging to the caller's own tenant.

import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
import { runPull, type DataSourceRow } from "@/lib/connectors/pull";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 300;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let admin;
  try {
    // Needs write access to data sources (super_admin bypasses the check).
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

  const result = await runPull(source as DataSourceRow, { trigger: "manual", db });

  const status = result.status === "error" ? 502 : 200;
  return Response.json(result, { status });
}
