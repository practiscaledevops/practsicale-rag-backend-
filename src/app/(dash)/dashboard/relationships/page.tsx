import { requireAdmin } from "@/lib/auth/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { RelationshipsClient } from "./RelationshipsClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Relationships" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /dashboard/relationships — how knowledge connects: confirmed edges + the AI's suggestions to review. */
export default async function RelationshipsPage() {
  await requireAdmin();
  return (
    <div>
      <PageHeader
        title="Relationships"
        description="How knowledge connects: MG-001 complements MG-002, is implemented in IMP-014 and validated by EXP-032. Links the AI suggests wait here for your review."
      />
      <RelationshipsClient />
    </div>
  );
}
