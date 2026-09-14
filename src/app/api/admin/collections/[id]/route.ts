// PATCH  /api/admin/collections/[id] — rename a collection (and edit description).
// DELETE /api/admin/collections/[id] — delete a collection.
//
// org_id is resolved SERVER-SIDE from the admin session (never from the request)
// and every query is filtered by it, so a request can only ever touch a
// collection in the caller's own tenant.
//
// Deleting a collection cascades its document_collections rows away (FK
// `on delete cascade`, migration 0008). We ALSO strip the deleted collection id
// out of chunks.collection_ids for every affected document, so scoped retrieval
// never matches a collection that no longer exists (see syncChunkCollectionIds).

import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

type Db = ReturnType<typeof supabaseAdmin>;

function guard(e: unknown): Response {
  const err = e as AdminAuthError;
  return Response.json({ error: err.message }, { status: err.status ?? 401 });
}

function slugify(name: string): string | null {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || null;
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

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let admin;
  try {
    admin = await requireAdmin("collections:write");
  } catch (e) {
    return guard(e);
  }

  const { id } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Build a partial update. `name` (when present) also refreshes the slug;
  // `description` can be cleared by sending an empty string; `settings` (the
  // governance config, migration 0013) replaces the jsonb blob wholesale.
  const patch: {
    name?: string;
    slug?: string;
    description?: string | null;
    settings?: Record<string, unknown>;
  } = {};

  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name) return Response.json({ error: "Name cannot be empty" }, { status: 400 });
    const slug = slugify(name);
    if (!slug) {
      return Response.json(
        { error: "Name must contain at least one letter or number" },
        { status: 400 }
      );
    }
    patch.name = name;
    patch.slug = slug;
  }

  if (typeof body.description === "string") {
    patch.description = body.description.trim() === "" ? null : body.description.trim();
  }

  const wantsSettings =
    body.settings != null && typeof body.settings === "object" && !Array.isArray(body.settings);
  if (wantsSettings) {
    patch.settings = body.settings as Record<string, unknown>;
  }

  if (Object.keys(patch).length === 0) {
    return Response.json({ error: "Nothing to update" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const selectCols = wantsSettings
    ? "id, name, slug, description, created_at, settings"
    : "id, name, slug, description, created_at";
  const { data, error } = await db
    .from("collections")
    .update(patch)
    .eq("id", id)
    .eq("org_id", admin.orgId) // tenant scope
    .select(selectCols)
    .maybeSingle();

  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return Response.json(
        { error: "A collection with a similar name already exists." },
        { status: 409 }
      );
    }
    // 42703 = undefined_column → governance settings need migration 0013.
    if ((error as { code?: string }).code === "42703") {
      return Response.json(
        { error: "Governance settings aren't enabled yet — run migration 0013_collection_settings.sql.", needsMigration: true },
        { status: 400 }
      );
    }
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data) return Response.json({ error: "Collection not found" }, { status: 404 });

  return Response.json({ collection: data });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let admin;
  try {
    admin = await requireAdmin("collections:write");
  } catch (e) {
    return guard(e);
  }

  const { id } = await ctx.params;
  const db = supabaseAdmin();

  // Capture the documents that currently belong to this collection BEFORE the
  // delete cascade removes the membership rows — we need them to re-sync chunks.
  const { data: members } = await db
    .from("document_collections")
    .select("document_id")
    .eq("org_id", admin.orgId)
    .eq("collection_id", id);

  const { data: deleted, error } = await db
    .from("collections")
    .delete()
    .eq("id", id)
    .eq("org_id", admin.orgId) // tenant scope
    .select("id")
    .maybeSingle();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!deleted) return Response.json({ error: "Collection not found" }, { status: 404 });

  // Re-derive each affected document's remaining membership and mirror it onto
  // its chunks, dropping the now-deleted collection id from chunks.collection_ids.
  const documentIds = [
    ...new Set(
      (members ?? []).map((m: { document_id: string }) => m.document_id)
    ),
  ];
  for (const documentId of documentIds) {
    await syncChunkCollectionIds(db, admin.orgId, documentId);
  }

  return Response.json({ id: deleted.id, removed: true });
}
