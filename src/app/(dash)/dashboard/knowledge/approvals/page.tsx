import { redirect } from "next/navigation";
import { pageAccess } from "@/lib/auth/page-guard";
import { NoAccessNotice } from "@/components/auth/PermissionGate";
import { can } from "@/lib/auth/permissions";
import { PageHeader } from "@/components/ui";
import { ApprovalsClient } from "./ApprovalsClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Approvals" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Readable by anyone with documents:read (org + access resolved server-side):
//   - an uploader opens it to track their OWN submissions' status + reviewer notes;
//   - an approver (super_admin / documents:approve) additionally gets the review
//     queue with approve/reject. The approve/reject POST route enforces
//     documents:approve on every call, so the client controls are a convenience,
//     not the gate.
export default async function ApprovalsPage() {
  const { session, allowed } = await pageAccess("documents:read");
  if (!session) redirect("/login");
  if (!allowed) return <NoAccessNotice />;
  const canApprove = can(session, "documents:approve");

  return (
    <div>
      <PageHeader
        title="Approvals"
        description={
          canApprove
            ? "Review knowledge that members submitted before it goes live — approve to ingest it, or reject with a note."
            : "Track knowledge you submitted for review. A super admin approves it before it goes live."
        }
      />
      <ApprovalsClient canApprove={canApprove} />
    </div>
  );
}
