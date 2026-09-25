import { requireAdmin } from "@/lib/auth/admin";
import { RelationshipsClient } from "./RelationshipsClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Relationships" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /dashboard/relationships — how knowledge connects: confirmed edges + the AI's
 * suggestions to review. The client renders the page header, whose
 * "Add relationship" button opens the connect dialog (so the table gets the
 * full page width).
 */
export default async function RelationshipsPage() {
  await requireAdmin();
  return <RelationshipsClient />;
}
