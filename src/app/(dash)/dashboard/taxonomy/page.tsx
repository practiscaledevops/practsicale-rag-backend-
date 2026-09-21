import { requireAdmin } from "@/lib/auth/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { TaxonomyClient } from "./TaxonomyClient";

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
        description="Domain and type are predefined; subtypes are controlled but extensible. The compiler reuses existing values and proposes new ones here."
      />
      <TaxonomyClient />
    </div>
  );
}
