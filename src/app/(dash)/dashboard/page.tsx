import { requireAdmin } from "@/lib/auth/admin";
import { getControlTowerData } from "@/lib/dashboard-metrics";
import { ControlTower } from "./ControlTower";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // always reflect current counts

/**
 * The CEO control-tower Overview. requireAdmin resolves org_id server-side from
 * the session (never client input); all metrics are computed org-scoped in
 * getControlTowerData and rendered by the client ControlTower (view toggle only).
 */
export default async function OverviewPage() {
  const admin = await requireAdmin();
  const data = await getControlTowerData(admin.orgId);
  return <ControlTower data={data} email={admin.email} />;
}
