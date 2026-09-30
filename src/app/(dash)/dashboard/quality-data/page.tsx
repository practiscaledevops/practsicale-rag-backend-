import { redirect } from "next/navigation";
import { pageAccess } from "@/lib/auth/page-guard";
import { NoAccessNotice } from "@/components/auth/PermissionGate";
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
 * server-side; all signals computed from existing rows. Gated on documents:read
 * (write/delete imply read; super_admin/demo always pass).
 */
export default async function DataQualityPage() {
  const { session, allowed } = await pageAccess("documents:read");
  if (!session) redirect("/login");
  if (!allowed) return <NoAccessNotice />;
  const data = await getDataQuality(session.orgId);

  return (
    <div>
      <PageHeader title="Data quality" description="Documents and collections that need attention." />
      <DataQualityClient data={data} />
    </div>
  );
}
