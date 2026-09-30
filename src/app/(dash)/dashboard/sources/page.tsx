import { redirect } from "next/navigation";
import { pageAccess } from "@/lib/auth/page-guard";
import { NoAccessNotice } from "@/components/auth/PermissionGate";
import { supabaseAdmin } from "@/lib/supabase";
import { Alert, PageHeader } from "@/components/ui";
import { SourcesClient, type DataSource } from "./SourcesClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Sources" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // always reflect current sources + status

// Columns kept in sync with the /api/admin/sources SELECT.
const SELECT =
  "id, name, slug, source_type, kind, endpoint_url, http_method, auth_type, " +
  "auth_secret_ref, records_path, cursor_field, cursor_value, schedule_cron, " +
  "is_active, last_run_at, last_status, created_at";

export default async function SourcesPage() {
  // Access + org resolved server-side (never client input). Viewing Sources needs
  // data_sources:read; write/delete imply read and super_admin sees all. The
  // /api/admin/sources routes enforce the same grants server-side.
  const { session, allowed } = await pageAccess("data_sources:read");
  if (!session) redirect("/login");
  if (!allowed) return <NoAccessNotice />;

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("data_sources")
    .select(SELECT)
    .eq("org_id", session.orgId)
    .order("created_at", { ascending: false });

  return (
    <div>
      <PageHeader
        title="Sources"
        description="Systems the Brain pulls knowledge from, and how their syncs are going."
      />

      {error ? (
        <Alert tone="danger" title="Couldn't load sources">
          <span className="text-danger">{error.message}</span>
        </Alert>
      ) : (
        <SourcesClient sources={(data as unknown as DataSource[]) ?? []} />
      )}
    </div>
  );
}
