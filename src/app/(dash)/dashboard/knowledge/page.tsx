import { Suspense } from "react";
import Link from "next/link";
import { PlusCircle } from "lucide-react";
import { requireAdmin } from "@/lib/auth/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { buttonClass } from "@/components/ui/Button";
import { KnowledgeObjectsClient } from "./KnowledgeObjectsClient";
import DashboardLoading from "../loading";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Knowledge objects" };

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
        description="Everything the Brain knows, with its class, trust level and status."
        actions={
          <Link href="/dashboard/knowledge/add" className={buttonClass({ size: "toolbar" })}>
            <PlusCircle size={14} aria-hidden />
            Add knowledge
          </Link>
        }
      />
      {/* The explorer reads its initial filters from the URL (useSearchParams), which needs a Suspense boundary. */}
      <Suspense fallback={<DashboardLoading />}>
        <KnowledgeObjectsClient />
      </Suspense>
    </div>
  );
}
