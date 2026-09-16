import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
import { supabaseAdmin } from "@/lib/supabase";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert } from "@/components/ui/Alert";
import {
  KnowledgeWorkspace,
  type WsCollection,
  type WsDocument,
} from "./KnowledgeWorkspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DOC_LIMIT = 3000;

interface RawCol {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  created_at: string;
  settings?: Record<string, unknown> | null;
  document_collections: { count: number }[] | null;
}
interface RawDoc {
  id: string;
  title: string | null;
  source_type: string;
  uri: string | null;
  created_at: string;
  updated_at: string | null;
  metadata: Record<string, unknown> | null;
  chunks: { count: number }[] | null;
  document_collections: { collection_id: string }[] | null;
}

function meta(m: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!m) return null;
  for (const k of keys) {
    const v = m[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Load collections, tolerating a missing `settings` column (pre-migration 0013). */
async function loadCollections(db: ReturnType<typeof supabaseAdmin>, orgId: string) {
  const base = "id, name, slug, description, created_at, document_collections(count)";
  const withSettings = await db
    .from("collections")
    .select(`${base}, settings`)
    .eq("org_id", orgId)
    .order("name", { ascending: true });
  if (!withSettings.error) return { data: withSettings.data as RawCol[] | null, enabled: true };
  const fb = await db
    .from("collections")
    .select(base)
    .eq("org_id", orgId)
    .order("name", { ascending: true });
  return { data: fb.data as RawCol[] | null, enabled: false };
}

export default async function CollectionsPage() {
  let admin;
  try {
    admin = await requireAdmin("collections:read");
  } catch (e) {
    const err = e as AdminAuthError;
    return (
      <div>
        <PageHeader title="Collections" description="Your knowledge, organized by collection." />
        <Alert tone="danger" title="You don't have access to collections">
          {err.status === 403
            ? "Your account is missing the 'collections:read' permission. Ask an administrator to grant it."
            : err.message}
        </Alert>
      </div>
    );
  }

  const db = supabaseAdmin();
  const [colRes, docRes] = await Promise.all([
    loadCollections(db, admin.orgId),
    db
      .from("documents")
      .select(
        "id, title, source_type, uri, created_at, updated_at, metadata, chunks(count), document_collections(collection_id)"
      )
      .eq("org_id", admin.orgId)
      .order("updated_at", { ascending: false })
      .limit(DOC_LIMIT),
  ]);

  const collections: WsCollection[] = ((colRes.data as RawCol[]) ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    createdAt: c.created_at,
    docCount: c.document_collections?.[0]?.count ?? 0,
    settings: (c.settings ?? {}) as WsCollection["settings"],
  }));

  const documents: WsDocument[] = ((docRes.data as unknown as RawDoc[]) ?? []).map((d) => ({
    id: d.id,
    title: d.title,
    sourceType: d.source_type,
    uri: d.uri,
    createdAt: d.created_at,
    updatedAt: d.updated_at ?? d.created_at,
    chunkCount: d.chunks?.[0]?.count ?? 0,
    category: meta(d.metadata, "category"),
    owner: meta(d.metadata, "owner", "source_owner", "author"),
    access: meta(d.metadata, "confidentiality", "access_level", "access"),
    reviewDate: meta(d.metadata, "review_date", "expiry_date"),
    collectionIds: (d.document_collections ?? []).map((x) => x.collection_id).filter(Boolean),
  }));

  return (
    <KnowledgeWorkspace
      collections={collections}
      documents={documents}
      governanceEnabled={colRes.enabled}
    />
  );
}
