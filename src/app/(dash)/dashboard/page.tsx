import { requireAdmin } from "@/lib/auth/admin";
import { supabaseAdmin } from "@/lib/supabase";
import { getBrainOverview } from "@/lib/brain-overview";
import { getControlTowerData } from "@/lib/dashboard-metrics";
import { OverviewClient } from "./OverviewClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // always reflect current numbers

/**
 * /dashboard — the AI Brain overview (the landing page). requireAdmin resolves
 * org_id server-side from the session (never client input); the Brain overview
 * and the operational metrics are computed org-scoped in parallel and handed to
 * the client fully populated, so nothing loads on first paint. The client's
 * Refresh button re-fetches /api/admin/knowledge/overview.
 */
export default async function OverviewPage() {
  const admin = await requireAdmin();
  const [brain, operations] = await Promise.all([
    getBrainOverview(supabaseAdmin(), admin.orgId),
    getControlTowerData(admin.orgId),
  ]);
  return <OverviewClient brain={brain} operations={operations} email={admin.email} />;
}
