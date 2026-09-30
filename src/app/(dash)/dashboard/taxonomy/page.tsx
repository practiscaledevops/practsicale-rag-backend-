import { redirect } from "next/navigation";
import { pageAccess } from "@/lib/auth/page-guard";
import { NoAccessNotice } from "@/components/auth/PermissionGate";
import { PageHeader } from "@/components/ui/PageHeader";
import { TaxonomyClient } from "./TaxonomyClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Taxonomy" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /dashboard/taxonomy — CLASS → DOMAIN → TYPE → SUBTYPE: the controlled,
 *  extensible vocabulary, with the AI's proposals waiting for approval. Gated on
 *  documents:read (write/delete imply read; super_admin/demo always pass). */
export default async function TaxonomyPage() {
  const { session, allowed } = await pageAccess("documents:read");
  if (!session) redirect("/login");
  if (!allowed) return <NoAccessNotice />;
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
