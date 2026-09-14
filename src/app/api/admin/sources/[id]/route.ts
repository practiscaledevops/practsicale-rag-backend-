// PATCH /api/admin/sources/[id] — update a data source's operational settings.
//
// Admin-only (dashboard session, data_sources:write). For now this toggles the
// sync on/off (pause/resume); org_id is resolved SERVER-SIDE and the update is
// filtered by it, so a caller can only ever change a source in their own tenant.

import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let admin;
  try {
    admin = await requireAdmin("data_sources:write");
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body?.is_active === "boolean") update.is_active = body.is_active;

  if (Object.keys(update).length === 1) {
    return Response.json({ error: "No supported fields to update." }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("data_sources")
    .update(update)
    .eq("id", id)
    .eq("org_id", admin.orgId)
    .select("id, is_active")
    .maybeSingle();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data) return Response.json({ error: "Data source not found" }, { status: 404 });

  return Response.json({ ok: true, is_active: (data as { is_active: boolean }).is_active });
}
