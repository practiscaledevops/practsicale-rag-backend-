import { Suspense } from "react";
import { requireAdmin } from "@/lib/auth/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { KnowledgeObjectsClient } from "./KnowledgeObjectsClient";
import DashboardLoading from "../loading";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /dashboard/knowledge — the intelligence objects explorer: Business Reality /
 * Playbooks / Organizational Learning / Platform Intelligence, classified as
 * CLASS → DOMAIN → TYPE → SUBTYPE with governance (endorsement, validation,
 * authority, currency). Org resolved server-side; data loads from the admin API.
 */
export default async function KnowledgePage() {
  await requireAdmin();
  return (
    <div>
      <PageHeader
        title="Knowledge objects"
        description="Everything the Brain knows, as connected intelligence objects — not a pile of documents. Filter by class, domain, type and governance."
      />
      {/* The explorer reads its initial filters from the URL (useSearchParams), which needs a Suspense boundary. */}
      <Suspense fallback={<DashboardLoading />}>
        <KnowledgeObjectsClient />
      </Suspense>
    </div>
  );
}
