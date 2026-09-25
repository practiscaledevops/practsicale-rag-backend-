import { requireAdmin } from "@/lib/auth/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { LearningLabClient } from "./LearningLabClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Learning Lab" };

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
    <div className="min-w-0">
      <PageHeader
        title="Learning Lab"
        description="Decisions, experiments and lessons the team records, and what they prove."
      />
      <LearningLabClient />
    </div>
  );
}
