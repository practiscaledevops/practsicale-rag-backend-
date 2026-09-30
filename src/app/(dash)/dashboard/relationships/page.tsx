import { redirect } from "next/navigation";
import { pageAccess } from "@/lib/auth/page-guard";
import { NoAccessNotice } from "@/components/auth/PermissionGate";
import { RelationshipsClient } from "./RelationshipsClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Relationships" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /dashboard/relationships — how knowledge connects: confirmed edges + the AI's
 * suggestions to review. The client renders the page header, whose
 * "Add relationship" button opens the connect dialog (so the table gets the
 * full page width). Gated on documents:read (write/delete imply read;
 * super_admin/demo always pass).
 */
export default async function RelationshipsPage() {
  const { session, allowed } = await pageAccess("documents:read");
  if (!session) redirect("/login");
  if (!allowed) return <NoAccessNotice />;
  return <RelationshipsClient />;
}
