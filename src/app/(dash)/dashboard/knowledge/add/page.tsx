import { redirect } from "next/navigation";
import { pageAccess } from "@/lib/auth/page-guard";
import { NoAccessNotice } from "@/components/auth/PermissionGate";
import { PageHeader } from "@/components/ui/PageHeader";
import { AddKnowledgeWizard } from "./AddKnowledgeWizard";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Add knowledge" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /dashboard/knowledge/add — "Give the Brain information, tell it what class it
 * is, and the Brain organizes itself." The human picks the intelligence class;
 * the AI ingestion agent extracts, classifies, de-duplicates and compiles the
 * canonical object; the human reviews and saves.
 */
export default async function AddKnowledgePage() {
  // Adding knowledge is a write (upload/create) action, so gate on documents:write:
  // a read-only member sees the notice and the nav hides this page for them.
  const { session, allowed } = await pageAccess("documents:write");
  if (!session) redirect("/login");
  if (!allowed) return <NoAccessNotice />;
  return (
    <div>
      <PageHeader
        title="Add knowledge"
        description="Paste text, upload a file or add a link — the Brain classifies it and asks you to review before saving."
      />
      <AddKnowledgeWizard />
    </div>
  );
}
