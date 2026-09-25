import Link from "next/link";
import { Plus, Upload } from "lucide-react";
import { requireAdmin } from "@/lib/auth/admin";
import { supabaseAdmin } from "@/lib/supabase";
import { isMissingRelation } from "@/lib/knowledge-store";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert } from "@/components/ui/Alert";
import { buttonClass } from "@/components/ui/Button";
import { DocumentsClient, type CollectionOption, type DocumentRow } from "./DocumentsClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Documents" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // always reflect current documents

// Documents scale with ingested records (a pull sync writes one document per
// record), so bound the list. 1000 comfortably covers a single-org back office;
// pagination is the follow-up if a tenant ever outgrows it.
const LIST_LIMIT = 1000;

const DOC_SELECT =
  "id, title, source_type, uri, created_at, updated_at, metadata, chunks(count), document_collections(collections(name))";
// object_id (migration 0017) marks a document that belongs to a knowledge object;
// the list falls back to DOC_SELECT without it on an older schema.
const DOC_LANE_SELECT = `${DOC_SELECT}, object_id`;

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
  object_id?: string | null;
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
  const list = (select: string) =>
    db
      .from("documents")
      .select(select)
      .eq("org_id", admin.orgId)
      .order("created_at", { ascending: false })
      .limit(LIST_LIMIT);

  // The org's collections feed the bulk "Add to / Move to collection" picker.
  const [first, colRes] = await Promise.all([
    list(DOC_LANE_SELECT),
    db.from("collections").select("id, name").eq("org_id", admin.orgId).order("name", { ascending: true }),
  ]);
  // Pre-migration 0017 (42703 undefined_column): list without object_id.
  const { data, error } = first.error && isMissingRelation(first.error) ? await list(DOC_SELECT) : first;
  const collections: CollectionOption[] = ((colRes.data as { id: string; name: string | null }[] | null) ?? []).map(
    (c) => ({ id: c.id, name: c.name || "Untitled" })
  );

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
    object_id: d.object_id ?? null,
  }));

  // The query is capped at LIST_LIMIT rows; say so instead of truncating silently.
  const truncated = documents.length >= LIST_LIMIT;

  return (
    <div className="min-w-0">
      <PageHeader
        title="Documents"
        description="Every document in the Brain, with its processing status and freshness."
        actions={
          <>
            <Link href="/dashboard/uploads" className={buttonClass({ variant: "secondary", size: "toolbar" })}>
              <Upload size={14} aria-hidden />
              Bulk upload
            </Link>
            <Link href="/dashboard/knowledge/add" className={buttonClass({ variant: "primary", size: "toolbar" })}>
              <Plus size={14} aria-hidden />
              Add knowledge
            </Link>
          </>
        }
      />

      {error ? (
        <Alert tone="danger" title="Couldn't load documents">
          <span className="text-danger">{error.message}</span>
        </Alert>
      ) : (
        <DocumentsClient documents={documents} collections={collections} truncated={truncated} />
      )}
    </div>
  );
}
