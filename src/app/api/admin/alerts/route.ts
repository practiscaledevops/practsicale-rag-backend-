// GET /api/admin/alerts — live operational alerts for the notification center.
//
// Admin-only (dashboard session). org_id is resolved SERVER-SIDE; the alerts are
// derived from current state (see lib/alerts), so they're always accurate.

import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
import { getAlerts } from "@/lib/alerts";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const dynamic = "force-dynamic";

export async function GET() {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  const alerts = await getAlerts(admin.orgId);
  return Response.json({ alerts });
}
