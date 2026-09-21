import { requireAdmin } from "@/lib/auth/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { PerformanceClient } from "./PerformanceClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /dashboard/performance — Performance Memory: the structured numbers the Brain reasons from (close rate, show rate, profile visits…). */
export default async function PerformancePage() {
  await requireAdmin();
  return (
    <div>
      <PageHeader
        title="Performance memory"
        description="Structured results alongside the knowledge: the database gives the Brain the numbers, RAG gives it the conversations, and it reasons across both."
      />
      <PerformanceClient />
    </div>
  );
}
