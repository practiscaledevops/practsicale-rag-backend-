import { requireAdmin } from "@/lib/auth/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { PerformanceClient } from "./PerformanceClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Performance memory" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /dashboard/performance — Performance Memory: the structured numbers the Brain reasons from (close rate, show rate, profile visits…). */
export default async function PerformancePage() {
  await requireAdmin();
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
