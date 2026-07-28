import { requireAdmin } from "@/lib/auth/admin";
import { PageHeader } from "@/components/ui/PageHeader";
import { UploadsClient } from "./UploadsClient";

export const runtime = "nodejs";

export default async function UploadsPage() {
  // Gate the page on a signed-in admin (org resolved server-side). The upload
  // route itself enforces the `documents:write` permission on submit.
  await requireAdmin();

  return (
    <div>
      <PageHeader
        title="Uploads"
        description="Add files to the knowledge base by drag-and-drop or file picker."
      />
      <UploadsClient />
    </div>
  );
}
