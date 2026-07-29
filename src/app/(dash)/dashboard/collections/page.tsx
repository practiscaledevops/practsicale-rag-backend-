import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
import { supabaseAdmin } from "@/lib/supabase";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert } from "@/components/ui/Alert";
import {
  CollectionsClient,
  type CollectionRow,
  type DocumentOption,
} from "./CollectionsClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // always reflect current collections

// Embedded aggregate: PostgREST returns document_collections as [{ count: n }]
// per collection (FK document_collections.collection_id -> collections.id).
interface RawCollection {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  created_at: string;
  document_collections: { count: number }[] | null;
}

export default async function CollectionsPage() {
  // requireAdmin resolves org_id server-side from the session — never client input.
  // A signed-in admin without the collections:read grant sees a 403 notice
  // rather than an unhandled error (the layout already guarantees a session).
  let admin;
  try {
    admin = await requireAdmin("collections:read");
  } catch (e) {
    const err = e as AdminAuthError;
    return (
      <div>
        <PageHeader
          title="Collections"
          description="Group documents into collections that scoped API keys can be limited to."
        />
        <Alert tone="danger" title="You don't have access to collections">
          {err.status === 403
            ? "Your account is missing the 'collections:read' permission. Ask an administrator to grant it."
            : err.message}
        </Alert>
      </div>
    );
  }

  const db = supabaseAdmin();

  // Load, in parallel: collections (+counts), all org documents (for the picker),
  // and the full membership map (which document is in which collection).
  const [collectionsRes, documentsRes, membershipRes] = await Promise.all([
    db
      .from("collections")
      .select("id, name, slug, description, created_at, document_collections(count)")
      .eq("org_id", admin.orgId)
      .order("created_at", { ascending: false }),
    db
      .from("documents")
      .select("id, title, source_type")
      .eq("org_id", admin.orgId)
      .order("created_at", { ascending: false }),
    db
      .from("document_collections")
      .select("collection_id, document_id")
      .eq("org_id", admin.orgId),
  ]);

  const error = collectionsRes.error ?? documentsRes.error ?? membershipRes.error;

  const collections: CollectionRow[] = ((collectionsRes.data as RawCollection[]) ?? []).map(
    (c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
      created_at: c.created_at,
      document_count: c.document_collections?.[0]?.count ?? 0,
    })
  );

  const documents: DocumentOption[] = ((documentsRes.data as DocumentOption[]) ?? []).map(
    (d) => ({ id: d.id, title: d.title, source_type: d.source_type })
  );

  // Build { collectionId: [documentId, ...] } for the assign-documents picker.
  const membership: Record<string, string[]> = {};
  for (const row of (membershipRes.data as
    | { collection_id: string; document_id: string }[]
    | null) ?? []) {
    (membership[row.collection_id] ??= []).push(row.document_id);
  }

  return (
    <div>
      <PageHeader
        title="Collections"
        description="Group documents into collections that scoped API keys can be limited to."
      />

      {error ? (
        <Alert tone="danger" title="Could not load collections">
          {error.message}
        </Alert>
      ) : (
        <CollectionsClient
          collections={collections}
          documents={documents}
          membership={membership}
        />
      )}
    </div>
  );
}
