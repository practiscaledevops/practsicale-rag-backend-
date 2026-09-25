import { requireAdmin } from "@/lib/auth/admin";
import { PageHeader } from "@/components/ui";
import { DecisionsClient } from "./DecisionsClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Ingestion decisions" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /dashboard/decisions — every automatic classification / dedup / taxonomy / relationship decision, inspectable. */
export default async function DecisionsPage() {
  await requireAdmin();
  return (
    <div>
      <PageHeader
        title="Ingestion decisions"
        description="Why each item was added, merged or skipped during ingestion."
      />
      <DecisionsClient />
    </div>
  );
}
