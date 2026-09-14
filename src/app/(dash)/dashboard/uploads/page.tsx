import { requireAdmin } from "@/lib/auth/admin";
import { supabaseAdmin } from "@/lib/supabase";
import { PageHeader } from "@/components/ui/PageHeader";
import { UploadsClient, type CollectionOption } from "./UploadsClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function UploadsPage() {
  // Gate on a signed-in admin (org resolved server-side). The upload route itself
  // enforces `documents:write` on submit.
  const admin = await requireAdmin();

  const db = supabaseAdmin();
  const { data } = await db
    .from("collections")
    .select("id, name")
    .eq("org_id", admin.orgId)
    .order("name");
  const collections: CollectionOption[] = ((data ?? []) as { id: string; name: string }[]).map((c) => ({
    id: c.id,
    name: c.name,
  }));

  return (
    <div>
      <PageHeader
        title="Upload & ingest"
        description="Classify knowledge, then add files. Each file is extracted, redacted, chunked, embedded, and indexed for retrieval."
      />
      <UploadsClient collections={collections} />
    </div>
  );
}
