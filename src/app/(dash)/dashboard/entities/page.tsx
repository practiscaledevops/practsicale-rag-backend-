import { Suspense } from "react";
import { requireAdmin } from "@/lib/auth/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { Spinner } from "@/components/ui/Loading";
import { EntitiesClient } from "./EntitiesClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Entities" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /dashboard/entities — WHO and WHAT exist inside the knowledge (people, departments, clients, offers, campaigns, frameworks…). */
export default async function EntitiesPage() {
  await requireAdmin();
  return (
    <div>
      <PageHeader
        title="Entities"
        description="The people, teams, clients, offers and frameworks mentioned inside your knowledge. Extracted automatically when knowledge is added."
      />
      {/* The client reads the ?id= deep link with useSearchParams, which needs a Suspense boundary. */}
      <Suspense fallback={<Spinner label="Loading entities…" />}>
        <EntitiesClient />
      </Suspense>
    </div>
  );
}
