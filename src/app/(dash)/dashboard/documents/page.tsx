import { requireAdmin } from "@/lib/auth/admin";
import { supabaseAdmin } from "@/lib/supabase";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert } from "@/components/ui/Alert";
import { DocumentsClient, type DocumentRow } from "./DocumentsClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // always reflect current documents

// Embedded aggregate: PostgREST returns chunks as [{ count: n }] per document.
interface RawDoc {
  id: string;
  title: string | null;
  source_type: string;
  uri: string | null;
  created_at: string;
  chunks: { count: number }[] | null;
}

export default async function DocumentsPage() {
  // requireAdmin resolves org_id server-side from the session — never client input.
  const admin = await requireAdmin();

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("documents")
    .select("id, title, source_type, uri, created_at, chunks(count)")
    .eq("org_id", admin.orgId)
    .order("created_at", { ascending: false });

  const documents: DocumentRow[] = ((data as RawDoc[]) ?? []).map((d) => ({
    id: d.id,
    title: d.title,
    source_type: d.source_type,
    uri: d.uri,
    created_at: d.created_at,
    chunk_count: d.chunks?.[0]?.count ?? 0,
  }));

  return (
    <div>
      <PageHeader
        title="Documents"
        description="Everything ingested into the knowledge base, from uploads and data-source syncs."
      />

      {error ? (
        <Alert tone="danger" title="Could not load documents">
          {error.message}
        </Alert>
      ) : (
        <DocumentsClient documents={documents} />
      )}
    </div>
  );
}
