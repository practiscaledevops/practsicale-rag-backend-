import { requireAdmin } from "@/lib/auth/admin";
import { DocumentDetailClient } from "./DocumentDetailClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Document" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // always reflect the current document + chunks

// Document inspector: the full "chunked & processed data" view for one document.
//
// This page is a thin server gate — it resolves the admin session (org_id is
// derived here, never from the URL) and enforces read permission. The heavy
// lifting (loading the document + every chunk, and the edit / delete / re-ingest
// actions) goes through the org-scoped API under /api/admin/documents/[id], which
// re-checks permissions on every request. The client fetches from that one route
// so there is a single source of truth for the inspector's data shape.
export default async function DocumentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin("documents:read");
  const { id } = await params;

  return <DocumentDetailClient documentId={id} />;
}
