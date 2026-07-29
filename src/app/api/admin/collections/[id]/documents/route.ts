// POST   /api/admin/collections/[id]/documents        — add a document to a collection.
// DELETE /api/admin/collections/[id]/documents?document_id=… — remove one.
//
// Membership lives in document_collections (org_id, document_id, collection_id).
// After every change we RE-SYNC chunks.collection_ids for the affected document
// so scoped retrieval by collection (hybrid_search_scoped) keeps working: each
// chunk carries a denormalized array of the collection ids its document belongs
// to (see migration 0008 — chunks.collection_ids + GIN index).
//
// org_id is resolved SERVER-SIDE from the admin session (never from the request)
// and both the collection and the document are verified to live in that org, so a
// request can only ever wire together resources within the caller's own tenant.

import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

type Db = ReturnType<typeof supabaseAdmin>;

function guard(e: unknown): Response {
  const err = e as AdminAuthError;
  return Response.json({ error: err.message }, { status: err.status ?? 401 });
}

/**
 * Re-derive a document's collection membership from document_collections (the
 * source of truth) and mirror it onto every chunk of that document. Recomputing
 * the full set — rather than blindly appending/removing one id — is idempotent
 * and can never drift or leave duplicate/stale ids in chunks.collection_ids.
 */
async function syncChunkCollectionIds(db: Db, orgId: string, documentId: string) {
  const { data: rows } = await db
    .from("document_collections")
    .select("collection_id")
    .eq("org_id", orgId)
    .eq("document_id", documentId);

  const collectionIds = (rows ?? []).map(
    (r: { collection_id: string }) => r.collection_id
  );

  await db
    .from("chunks")
    .update({ collection_ids: collectionIds })
    .eq("org_id", orgId)
    .eq("document_id", documentId);
}

/** Confirm the collection belongs to this org; returns false when it does not. */
async function collectionInOrg(db: Db, orgId: string, collectionId: string) {
  const { data } = await db
    .from("collections")
    .select("id")
    .eq("id", collectionId)
    .eq("org_id", orgId)
    .maybeSingle();
  return Boolean(data);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let admin;
  try {
    admin = await requireAdmin("collections:write");
  } catch (e) {
    return guard(e);
  }

  const { id: collectionId } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const documentId = typeof body.document_id === "string" ? body.document_id : "";
  if (!documentId) {
    return Response.json({ error: "document_id is required" }, { status: 400 });
  }

  const db = supabaseAdmin();

  // Both sides must live in the caller's org before we link them.
  if (!(await collectionInOrg(db, admin.orgId, collectionId))) {
    return Response.json({ error: "Collection not found" }, { status: 404 });
  }
  const { data: doc } = await db
    .from("documents")
    .select("id")
    .eq("id", documentId)
    .eq("org_id", admin.orgId)
    .maybeSingle();
  if (!doc) return Response.json({ error: "Document not found" }, { status: 404 });

  // Upsert the membership (PK is (document_id, collection_id)); re-adding is a
  // harmless no-op rather than a 409.
  const { error } = await db
    .from("document_collections")
    .upsert(
      { org_id: admin.orgId, document_id: documentId, collection_id: collectionId },
      { onConflict: "document_id,collection_id", ignoreDuplicates: true }
    );

  if (error) return Response.json({ error: error.message }, { status: 500 });

  // Keep the denormalized chunks.collection_ids in step with the new membership.
  await syncChunkCollectionIds(db, admin.orgId, documentId);

  return Response.json({ ok: true, added: true }, { status: 201 });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let admin;
  try {
    admin = await requireAdmin("collections:write");
  } catch (e) {
    return guard(e);
  }

  const { id: collectionId } = await ctx.params;
  const documentId = new URL(req.url).searchParams.get("document_id");
  if (!documentId) {
    return Response.json({ error: "document_id query param is required" }, { status: 400 });
  }

  const db = supabaseAdmin();

  // Scope the delete to this org + collection — a foreign id matches nothing.
  const { data: removed, error } = await db
    .from("document_collections")
    .delete()
    .eq("org_id", admin.orgId)
    .eq("collection_id", collectionId)
    .eq("document_id", documentId)
    .select("document_id")
    .maybeSingle();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!removed) {
    return Response.json({ error: "Document is not in this collection" }, { status: 404 });
  }

  // Recompute the document's remaining membership onto its chunks.
  await syncChunkCollectionIds(db, admin.orgId, documentId);

  return Response.json({ ok: true, removed: true });
}
