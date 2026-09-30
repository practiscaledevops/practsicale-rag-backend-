import { redirect } from "next/navigation";
import { pageAccess } from "@/lib/auth/page-guard";
import { NoAccessNotice } from "@/components/auth/PermissionGate";
import { supabaseAdmin } from "@/lib/supabase";
import { PageHeader } from "@/components/ui";
import { UploadsClient, type CollectionOption } from "./UploadsClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Bulk upload" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function UploadsPage() {
  // Bulk upload IS a write action, so it needs documents:write to view (not just
  // read) — matching the upload route, which enforces documents:write on submit.
  // Org + access resolved server-side; super_admin sees all.
  const { session, allowed } = await pageAccess("documents:write");
  if (!session) redirect("/login");
  if (!allowed) return <NoAccessNotice />;

  const db = supabaseAdmin();
  const { data } = await db
    .from("collections")
    .select("id, name")
    .eq("org_id", session.orgId)
    .order("name");
  const collections: CollectionOption[] = ((data ?? []) as { id: string; name: string }[]).map((c) => ({
    id: c.id,
    name: c.name,
  }));

  return (
    <div>
      <PageHeader
        title="Bulk upload"
        description="Upload Markdown, text or PDF files in bulk and tag them for retrieval."
      />
      <UploadsClient collections={collections} />
    </div>
  );
}
