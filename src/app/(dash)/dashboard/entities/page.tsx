import { Suspense } from "react";
import { redirect } from "next/navigation";
import { pageAccess } from "@/lib/auth/page-guard";
import { NoAccessNotice } from "@/components/auth/PermissionGate";
import { PageHeader } from "@/components/ui/PageHeader";
import { Spinner } from "@/components/ui/Loading";
import { EntitiesClient } from "./EntitiesClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Entities" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /dashboard/entities — WHO and WHAT exist inside the knowledge (people, departments, clients, offers, campaigns, frameworks…). */
export default async function EntitiesPage() {
  // Org resolved server-side; a member without documents:read sees the notice.
  const { session, allowed } = await pageAccess("documents:read");
  if (!session) redirect("/login");
  if (!allowed) return <NoAccessNotice />;
  return (
    // min-w-0: the table scrolls inside its own card; the page never widens the shell.
    <div className="min-w-0">
      <PageHeader
        title="Entities"
        description="The people, teams, clients, offers and frameworks mentioned inside your knowledge. Extracted automatically when knowledge is added; tick rows to merge duplicates or delete noise."
      />
      {/* The client reads the ?id= deep link with useSearchParams, which needs a Suspense boundary. */}
      <Suspense fallback={<Spinner label="Loading entities…" />}>
        <EntitiesClient />
      </Suspense>
    </div>
  );
}
