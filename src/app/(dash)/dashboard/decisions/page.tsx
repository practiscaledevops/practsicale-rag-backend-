import { redirect } from "next/navigation";
import { pageAccess } from "@/lib/auth/page-guard";
import { NoAccessNotice } from "@/components/auth/PermissionGate";
import { PageHeader } from "@/components/ui";
import { DecisionsClient } from "./DecisionsClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Ingestion decisions" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /dashboard/decisions — every automatic classification / dedup / taxonomy / relationship decision,
 *  inspectable. Gated on documents:read (write/delete imply read; super_admin/demo always pass). */
export default async function DecisionsPage() {
  const { session, allowed } = await pageAccess("documents:read");
  if (!session) redirect("/login");
  if (!allowed) return <NoAccessNotice />;
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
