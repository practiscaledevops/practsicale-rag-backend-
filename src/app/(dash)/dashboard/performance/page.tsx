import { redirect } from "next/navigation";
import { pageAccess } from "@/lib/auth/page-guard";
import { NoAccessNotice } from "@/components/auth/PermissionGate";
import { PageHeader } from "@/components/ui/PageHeader";
import { PerformanceClient } from "./PerformanceClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Performance memory" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /dashboard/performance — Performance Memory: the structured numbers the Brain reasons from (close rate,
 *  show rate, profile visits…). Gated on documents:read (write/delete imply read; super_admin/demo always pass). */
export default async function PerformancePage() {
  const { session, allowed } = await pageAccess("documents:read");
  if (!session) redirect("/login");
  if (!allowed) return <NoAccessNotice />;
  return (
    <div>
      <PageHeader
        title="Performance memory"
        description="The numbers the Brain reasons from, such as close rate and show rate, kept next to the knowledge. Matching metrics go into answers as verified data."
      />
      <PerformanceClient />
    </div>
  );
}
