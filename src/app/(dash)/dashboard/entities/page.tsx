import { requireAdmin } from "@/lib/auth/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { EntitiesClient } from "./EntitiesClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /dashboard/entities — WHO and WHAT exist inside the knowledge (people, departments, clients, offers, campaigns, frameworks…). */
export default async function EntitiesPage() {
  await requireAdmin();
  return (
    <div>
      <PageHeader
        title="Entities"
        description="Metadata says what an object is; entities say who and what live inside it. Extracted automatically at ingest."
      />
      <EntitiesClient />
    </div>
  );
}
