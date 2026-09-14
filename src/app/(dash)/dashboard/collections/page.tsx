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
  settings?: Record<string, unknown> | null;
  document_collections: { count: number }[] | null;
}

const BASE_COLS = "id, name, slug, description, created_at, document_collections(count)";

/**
 * Load collections, preferring the governance `settings` column but degrading to
 * the base columns if migration 0013 hasn't been applied (undefined_column). The
 * `enabled` flag tells the client whether to offer the governance editor.
 */
async function loadCollections(db: ReturnType<typeof supabaseAdmin>, orgId: string) {
  const withSettings = await db
    .from("collections")
    .select(`${BASE_COLS}, settings`)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });

  if (!withSettings.error) {
    return { data: withSettings.data as RawCollection[] | null, error: null, enabled: true };
  }
  // 42703 = undefined_column → settings not migrated yet. Fall back gracefully.
  const base = await db
    .from("collections")
    .select(BASE_COLS)
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });
  return { data: base.data as RawCollection[] | null, error: base.error, enabled: false };
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

  // Load, in parallel: collections (+counts +governance settings), all org
  // documents (for the picker), and the full membership map.
  const [collectionsRes, documentsRes, membershipRes] = await Promise.all([
    loadCollections(db, admin.orgId),
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
  const governanceEnabled = collectionsRes.enabled;

  const collections: CollectionRow[] = (collectionsRes.data ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    created_at: c.created_at,
    document_count: c.document_collections?.[0]?.count ?? 0,
    settings: (c.settings ?? {}) as CollectionRow["settings"],
  }));

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
          governanceEnabled={governanceEnabled}
        />
      )}
    </div>
  );
}
