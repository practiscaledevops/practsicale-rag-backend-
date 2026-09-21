import { requireAdmin } from "@/lib/auth/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { AddKnowledgeWizard } from "./AddKnowledgeWizard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /dashboard/knowledge/add — "Give the Brain information, tell it what class it
 * is, and the Brain organizes itself." The human picks the intelligence class;
 * the AI ingestion agent extracts, classifies, de-duplicates and compiles the
 * canonical object; the human reviews and saves.
 */
export default async function AddKnowledgePage() {
  await requireAdmin("documents:write");
  return (
    <div>
      <PageHeader
        title="Add knowledge"
        description="Paste a transcript, clip caption, article, report or note — or upload a file. Choose what kind of knowledge it is; the Brain does the classification."
      />
      <AddKnowledgeWizard />
    </div>
  );
}
