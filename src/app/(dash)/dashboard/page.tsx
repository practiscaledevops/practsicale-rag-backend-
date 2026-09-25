import { requireAdmin } from "@/lib/auth/admin";
import { supabaseAdmin } from "@/lib/supabase";
import { getBrainOverview } from "@/lib/brain-overview";
import { getControlTowerData } from "@/lib/dashboard-metrics";
import { OverviewClient } from "./OverviewClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Overview" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // always reflect current numbers

/**
 * /dashboard — the AI Brain overview (the landing page). requireAdmin resolves
 * org_id server-side from the session (never client input); the Brain overview
 * and the operational metrics are computed org-scoped in parallel and handed to
 * the client fully populated, so nothing loads on first paint. The client's
 * Refresh button re-fetches /api/admin/knowledge/overview.
 *
 * `?view=team` opens the Team view; the client keeps the URL in sync with
 * history.replaceState, so toggling never re-runs these loaders.
 */
export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const admin = await requireAdmin();
  const sp = await searchParams;
  const initialView = sp.view === "team" ? "team" : "ceo";
  const [brain, operations] = await Promise.all([
    getBrainOverview(supabaseAdmin(), admin.orgId),
    getControlTowerData(admin.orgId),
  ]);
  return <OverviewClient brain={brain} operations={operations} email={admin.email} initialView={initialView} />;
}
