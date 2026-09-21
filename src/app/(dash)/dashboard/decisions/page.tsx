import { requireAdmin } from "@/lib/auth/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { DecisionsClient } from "./DecisionsClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /dashboard/decisions — every automatic classification / dedup / taxonomy / relationship decision, inspectable. */
export default async function DecisionsPage() {
  await requireAdmin();
  return (
    <div>
      <PageHeader
        title="Ingestion decisions"
        description="What the AI ingestion agent decided and why: classify, taxonomy reuse/propose, NEW / ENRICH / DUPLICATE / CONFLICT, compile, entities, relationships."
      />
      <DecisionsClient />
    </div>
  );
}
