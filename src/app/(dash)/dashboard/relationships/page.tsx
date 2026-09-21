import { requireAdmin } from "@/lib/auth/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { RelationshipsClient } from "./RelationshipsClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /dashboard/relationships — how knowledge connects: confirmed edges + the AI's suggestions to review. */
export default async function RelationshipsPage() {
  await requireAdmin();
  return (
    <div>
      <PageHeader
        title="Relationships"
        description="The Brain's graph, without a graph database: MG-001 complements MG-002, implemented in IMP-014, validated by EXP-032. Suggestions wait for your confirmation."
      />
      <RelationshipsClient />
    </div>
  );
}
