import { requireAdmin } from "@/lib/auth/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { BrainOverviewClient } from "./BrainOverviewClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /dashboard/brain — the AI Brain overview: one page that explains, in plain
 * English and with live numbers, everything that is inside the Brain. Org is
 * resolved server-side; the numbers load from the admin overview API.
 */
export default async function BrainOverviewPage() {
  await requireAdmin();
  return (
    <div>
      <PageHeader
        title="AI Brain overview"
        description="What the Brain knows, what it trusts, what it has learned, how it is connected, fed and answering — with live numbers for every part."
      />
      <BrainOverviewClient />
    </div>
  );
}
