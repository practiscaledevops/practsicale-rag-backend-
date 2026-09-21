import { requireAdmin } from "@/lib/auth/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { LearningLabClient } from "./LearningLabClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /dashboard/learning — the Learning Lab: Organizational Learning's memory of
 * what PractiScale decided, implemented, measured and learned. Mostly generated
 * from real work (chat detection); manual recording stays possible.
 */
export default async function LearningLabPage() {
  await requireAdmin();
  return (
    <div>
      <PageHeader
        title="Learning Lab"
        description="Decision → implementation → experiment → result → learning → adaptation → PractiScale standard. Reality stores the evidence; this stores the interpretation."
      />
      <LearningLabClient />
    </div>
  );
}
