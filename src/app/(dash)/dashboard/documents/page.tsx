import { requireAdmin } from "@/lib/auth/admin";
import { supabaseAdmin } from "@/lib/supabase";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert } from "@/components/ui/Alert";
import { DocumentsClient, type DocumentRow } from "./DocumentsClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // always reflect current documents

// Documents scale with ingested records (a pull sync writes one document per
// record), so bound the list. 1000 comfortably covers a single-org back office;
// pagination is the follow-up if a tenant ever outgrows it.
const LIST_LIMIT = 1000;

// Embedded aggregates: PostgREST returns chunks as [{ count: n }] per document,
// and the collection membership as a nested relation.
interface RawDoc {
  id: string;
  title: string | null;
  source_type: string;
  uri: string | null;
  created_at: string;
  updated_at: string | null;
  metadata: Record<string, unknown> | null;
  chunks: { count: number }[] | null;
  document_collections: { collections: { name: string | null } | null }[] | null;
}

/** Read the first present string value among candidate metadata keys. */
function meta(m: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!m) return null;
  for (const k of keys) {
    const v = m[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export default async function DocumentsPage() {
  // requireAdmin resolves org_id server-side from the session — never client input.
  const admin = await requireAdmin();

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("documents")
    .select(
      "id, title, source_type, uri, created_at, updated_at, metadata, chunks(count), document_collections(collections(name))"
    )
    .eq("org_id", admin.orgId)
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);

  const documents: DocumentRow[] = ((data as unknown as RawDoc[]) ?? []).map((d) => ({
    id: d.id,
    title: d.title,
    source_type: d.source_type,
    uri: d.uri,
    created_at: d.created_at,
    updated_at: d.updated_at ?? d.created_at,
    chunk_count: d.chunks?.[0]?.count ?? 0,
    collection: d.document_collections?.[0]?.collections?.name ?? null,
    category: meta(d.metadata, "category"),
    owner: meta(d.metadata, "owner", "source_owner", "author"),
    access: meta(d.metadata, "confidentiality", "access_level", "access"),
    review_date: meta(d.metadata, "review_date", "expiry_date"),
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
