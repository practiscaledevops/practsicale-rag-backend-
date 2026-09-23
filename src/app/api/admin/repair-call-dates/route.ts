// POST /api/admin/repair-call-dates — align every stored call date with the
// scoring app (see lib/connectors/repair-dates). Admin-only; scoped to the
// caller's org, resolved server-side. Idempotent — safe to run repeatedly.

import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
import { repairCallDates } from "@/lib/connectors/repair-dates";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 300;

export async function POST() {
  let admin;
  try {
    admin = await requireAdmin("data_sources:write");
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  try {
    const result = await repairCallDates(admin.orgId, supabaseAdmin());
    return Response.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "repair failed";
    return Response.json({ error: message }, { status: 502 });
  }
}
