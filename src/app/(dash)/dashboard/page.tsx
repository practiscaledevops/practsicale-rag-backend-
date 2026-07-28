import { Database, FileText, KeyRound, Activity, type LucideIcon } from "lucide-react";
import { requireAdmin } from "@/lib/auth/admin";
import { supabaseAdmin } from "@/lib/supabase";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardContent } from "@/components/ui/Card";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // always reflect current counts

/**
 * Count rows in `table` for this org. Uses a head-only count query (no rows
 * transferred). Returns null on error so one failing metric never blanks the
 * whole page.
 */
async function orgCount(table: string, orgId: string): Promise<number | null> {
  const db = supabaseAdmin();
  const { count, error } = await db
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq("org_id", orgId);
  return error ? null : count ?? 0;
}

interface Metric {
  label: string;
  value: number | null;
  href: string;
  icon: LucideIcon;
}

export default async function OverviewPage() {
  // requireAdmin resolves org_id server-side from the session — never client input.
  const admin = await requireAdmin();

  const [documents, dataSources, apiKeys, usageEvents] = await Promise.all([
    orgCount("documents", admin.orgId),
    orgCount("data_sources", admin.orgId),
    orgCount("api_keys", admin.orgId),
    orgCount("usage_events", admin.orgId),
  ]);

  const metrics: Metric[] = [
    { label: "Documents", value: documents, href: "/dashboard/documents", icon: FileText },
    { label: "Data sources", value: dataSources, href: "/dashboard/sources", icon: Database },
    { label: "API keys", value: apiKeys, href: "/dashboard/keys", icon: KeyRound },
    { label: "Usage events", value: usageEvents, href: "/dashboard/analytics", icon: Activity },
  ];

  return (
    <div>
      <PageHeader
        title="Overview"
        description={`Signed in as ${admin.email}`}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(({ label, value, href, icon: Icon }) => (
          <a key={label} href={href} className="group">
            <Card className="transition-colors group-hover:border-accent/40">
              <CardContent className="flex items-center justify-between p-5">
                <div>
                  <p className="text-sm text-muted-foreground">{label}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">
                    {value === null ? "—" : value.toLocaleString()}
                  </p>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-muted text-muted-foreground">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </div>
              </CardContent>
            </Card>
          </a>
        ))}
      </div>
    </div>
  );
}
