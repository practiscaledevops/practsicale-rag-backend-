import { requireAdmin } from "@/lib/auth/admin";
import { getDataQuality } from "@/lib/data-quality";
import { PageHeader } from "@/components/ui";
import { DataQualityClient } from "./DataQualityClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Data quality" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /dashboard/quality-data — Data quality: freshness, ownership, processing health,
 * and searchability of the knowledge base, with fix-it actions. Org resolved
 * server-side; all signals computed from existing rows.
 */
export default async function DataQualityPage() {
  const admin = await requireAdmin();
  const data = await getDataQuality(admin.orgId);

  return (
    <div>
      <PageHeader title="Data quality" description="Documents and collections that need attention." />
      <DataQualityClient data={data} />
    </div>
  );
}
