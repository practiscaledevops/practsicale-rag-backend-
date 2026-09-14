// Live operational alerts for the Brain's notification center. DERIVED from
// current state on each read (no notifications table, so they're always accurate
// and never go stale): failed/overdue syncs, unowned collections, stale and
// review-due knowledge. Cheap count queries + one small data_sources fetch, so
// it's safe to poll. Priorities map to the dashboard's colors:
//   error → red · warning → amber · info → blue · success → teal · ceo → purple

import { supabaseAdmin } from "@/lib/supabase";

export type AlertPriority = "error" | "warning" | "info" | "success" | "ceo";

export interface Alert {
  id: string;
  priority: AlertPriority;
  title: string;
  body: string;
  href: string;
}

const STALE_DAYS = 90;
const OVERDUE_MS = 2 * 60 * 60 * 1000; // a scheduled source silent > 2h is overdue

/** Head-count that never throws (missing column / table → 0). */
async function safeCount(
  build: (db: ReturnType<typeof supabaseAdmin>) => PromiseLike<{ count: number | null; error: unknown }>
): Promise<number> {
  try {
    const { count, error } = await build(supabaseAdmin());
    return error ? 0 : count ?? 0;
  } catch {
    return 0;
  }
}

export async function getAlerts(orgId: string): Promise<Alert[]> {
  const db = supabaseAdmin();
  const now = Date.now();
  const staleCut = new Date(now - STALE_DAYS * 86_400_000).toISOString();
  const dayAgo = new Date(now - 86_400_000).toISOString();
  const todayISO = new Date(now).toISOString();

  const [sourcesRes, staleCount, reviewDue, noOwner, failedRuns] = await Promise.all([
    db
      .from("data_sources")
      .select("id, name, is_active, last_status, last_run_at, schedule_cron")
      .eq("org_id", orgId),
    safeCount((d) =>
      d.from("documents").select("*", { count: "exact", head: true }).eq("org_id", orgId).lt("updated_at", staleCut)
    ),
    safeCount((d) =>
      d
        .from("documents")
        .select("*", { count: "exact", head: true })
        .eq("org_id", orgId)
        .not("metadata->>review_date", "is", null)
        .lt("metadata->>review_date", todayISO)
    ),
    safeCount((d) =>
      d.from("collections").select("*", { count: "exact", head: true }).eq("org_id", orgId).is("settings->>owner", null)
    ),
    safeCount((d) =>
      d.from("ingestion_runs").select("*", { count: "exact", head: true }).eq("org_id", orgId).eq("status", "error").gte("started_at", dayAgo)
    ),
  ]);

  const alerts: Alert[] = [];
  const sources = (sourcesRes.data ?? []) as {
    id: string;
    name: string;
    is_active: boolean;
    last_status: string | null;
    last_run_at: string | null;
    schedule_cron: string | null;
  }[];

  // Per-source: failed last sync (red) or overdue scheduled sync (amber).
  for (const s of sources) {
    if (s.last_status === "error") {
      alerts.push({
        id: `src-error-${s.id}`,
        priority: "error",
        title: `Sync failed: ${s.name}`,
        body: "The last sync errored. Open the connector to retry.",
        href: `/dashboard/sources/${s.id}`,
      });
      continue;
    }
    if (s.is_active && s.schedule_cron) {
      const last = s.last_run_at ? new Date(s.last_run_at).getTime() : 0;
      if (!last || now - last > OVERDUE_MS) {
        alerts.push({
          id: `src-overdue-${s.id}`,
          priority: "warning",
          title: `Connector overdue: ${s.name}`,
          body: last ? "Hasn't synced on schedule." : "Scheduled but never synced.",
          href: `/dashboard/sources/${s.id}`,
        });
      }
    }
  }

  if (failedRuns > 0) {
    alerts.push({
      id: "runs-failed",
      priority: "error",
      title: `${failedRuns} ingestion run${failedRuns === 1 ? "" : "s"} failed in the last day`,
      body: "Review the failures and retry them safely.",
      href: "/dashboard/quality-data",
    });
  }
  if (reviewDue > 0) {
    alerts.push({
      id: "review-due",
      priority: "warning",
      title: `${reviewDue} document${reviewDue === 1 ? "" : "s"} past review date`,
      body: "A source owner should re-confirm these are still accurate.",
      href: "/dashboard/quality-data",
    });
  }
  if (noOwner > 0) {
    alerts.push({
      id: "no-owner",
      priority: "warning",
      title: `${noOwner} collection${noOwner === 1 ? "" : "s"} without an owner`,
      body: "Assign an owner in each collection's governance settings.",
      href: "/dashboard/collections",
    });
  }
  if (staleCount > 0) {
    alerts.push({
      id: "stale",
      priority: "info",
      title: `${staleCount} source${staleCount === 1 ? "" : "s"} not updated in 90+ days`,
      body: "Aging knowledge — verify it's still current.",
      href: "/dashboard/quality-data",
    });
  }

  // Most severe first.
  const rank: Record<AlertPriority, number> = { error: 0, ceo: 1, warning: 2, info: 3, success: 4 };
  alerts.sort((a, b) => rank[a.priority] - rank[b.priority]);
  return alerts;
}
