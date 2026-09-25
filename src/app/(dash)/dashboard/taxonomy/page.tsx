import { requireAdmin } from "@/lib/auth/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { TaxonomyClient } from "./TaxonomyClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Taxonomy" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /dashboard/taxonomy — CLASS → DOMAIN → TYPE → SUBTYPE: the controlled,
 *  extensible vocabulary, with the AI's proposals waiting for approval. */
export default async function TaxonomyPage() {
  await requireAdmin();
  return (
    <div>
      <PageHeader
        title="Taxonomy"
        description="The vocabulary the Brain files knowledge under: class, domain, type and subtype. The AI reuses existing values and proposes new ones, which wait here for your approval."
      />
      <TaxonomyClient />
    </div>
  );
}
