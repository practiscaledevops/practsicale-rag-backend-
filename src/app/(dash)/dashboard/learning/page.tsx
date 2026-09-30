import { redirect } from "next/navigation";
import { pageAccess } from "@/lib/auth/page-guard";
import { NoAccessNotice } from "@/components/auth/PermissionGate";
import { PageHeader } from "@/components/ui/PageHeader";
import { LearningLabClient } from "./LearningLabClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Learning Lab" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /dashboard/learning — the Learning Lab: Organizational Learning's memory of
 * what PractiScale decided, implemented, measured and learned. Mostly generated
 * from real work (chat detection); manual recording stays possible. Gated on
 * documents:read (write/delete imply read; super_admin/demo always pass).
 */
export default async function LearningLabPage() {
  const { session, allowed } = await pageAccess("documents:read");
  if (!session) redirect("/login");
  if (!allowed) return <NoAccessNotice />;
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
