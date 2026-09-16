// GET /api/admin/documents/[id]/inspect — the document inspector payload for the
// Collections control center: the document's chunks (text, contextual summary,
// position, parent) in order. Admin-gated, org-scoped. Never selects the 1024-d
// embedding vector (heavy + must not leak); index status is derived from whether
// each chunk exists (the pipeline embeds on ingest).

import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  const { id } = await ctx.params;
  const db = supabaseAdmin();

  const { data: doc, error: docErr } = await db
    .from("documents")
    .select("id, title, source_type, uri, content_hash, metadata, created_at, updated_at")
    .eq("id", id)
    .eq("org_id", admin.orgId)
    .maybeSingle();
  if (docErr) return Response.json({ error: docErr.message }, { status: 500 });
  if (!doc) return Response.json({ error: "Document not found" }, { status: 404 });

  // Chunks in document order. Select only what the inspector renders — never the
  // embedding vector.
  const { data: chunkRows } = await db
    .from("chunks")
    .select("id, content, context, metadata, parent_id, token_count, created_at")
    .eq("org_id", admin.orgId)
    .eq("document_id", id)
    .order("created_at", { ascending: true })
    .limit(2000);

  const chunks = ((chunkRows ?? []) as Record<string, unknown>[]).map((c) => ({
    id: String(c.id),
    content: String(c.content ?? ""),
    context: (c.context as string) ?? null,
    parentId: (c.parent_id as string) ?? null,
    tokenCount: (c.token_count as number) ?? null,
    isParent: Boolean((c.metadata as { is_parent?: boolean } | null)?.is_parent),
  }));

  return Response.json({
    document: {
      id: String((doc as Record<string, unknown>).id),
      title: (doc as Record<string, unknown>).title ?? null,
      sourceType: String((doc as Record<string, unknown>).source_type ?? "document"),
      uri: (doc as Record<string, unknown>).uri ?? null,
      contentHash: (doc as Record<string, unknown>).content_hash ?? null,
      metadata: (doc as Record<string, unknown>).metadata ?? {},
      createdAt: (doc as Record<string, unknown>).created_at ?? null,
      updatedAt: (doc as Record<string, unknown>).updated_at ?? null,
    },
    chunks,
  });
}
