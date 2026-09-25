// POST   /api/admin/collections/[id]/documents        — add a document to a collection.
// DELETE /api/admin/collections/[id]/documents?document_id=… — remove one.
//
// Bulk forms (≤200 documents per request, JSON body):
//   POST   { document_ids }                          add them to this collection
//   POST   { document_ids, from_collection_id }      move them here from that collection
//   POST   { document_ids, exclusive: true }         move them here from every other collection
//   DELETE { document_ids }                          remove them from this collection
//   → { ok, ids: [done], failed: [{ id, error }], remaining: [ids to send again] }
// Every bulk form is idempotent (upsert / delete of a membership, then a
// re-derive of the chunks), so a client may resend `remaining` or a failed id.
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
import { isDemo } from "@/lib/demo/mode";
import { BULK_MAX_IDS } from "@/lib/bulk";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
// A bulk request writes the memberships in one statement, then updates each
// document's chunks (one statement per document) within SYNC_BUDGET_MS.
export const maxDuration = 60;

type Db = ReturnType<typeof supabaseAdmin>;

/** Stop starting new chunk syncs after this long; the rest go back as `remaining`. */
const SYNC_BUDGET_MS = 40_000;
/** Documents re-synced together (one membership read, then their chunk updates in parallel). */
const SYNC_SLICE = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The in-memory demo store uses short ids ("doc-1", "col-1"); only demo mode accepts them.
const DEMO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const idPattern = () => (isDemo() ? DEMO_ID_RE : UUID_RE);

interface BulkFailure {
  id: string;
  error: string;
}

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

/**
 * syncChunkCollectionIds for many documents: one membership read per slice,
 * then that slice's chunk updates in parallel. Slices that would start after
 * `deadline` come back as `remaining` (the client sends them again).
 */
async function syncManyChunkCollectionIds(
  db: Db,
  orgId: string,
  documentIds: string[],
  deadline: number
): Promise<{ ok: string[]; failed: BulkFailure[]; remaining: string[] }> {
  const ok: string[] = [];
  const failed: BulkFailure[] = [];
  const remaining: string[] = [];

  for (let i = 0; i < documentIds.length; i += SYNC_SLICE) {
    if (Date.now() > deadline) {
      remaining.push(...documentIds.slice(i));
      break;
    }
    const slice = documentIds.slice(i, i + SYNC_SLICE);
    const { data, error } = await db
      .from("document_collections")
      .select("document_id, collection_id")
      .eq("org_id", orgId)
      .in("document_id", slice);
    if (error) {
      for (const id of slice) failed.push({ id, error: `Couldn't read its collections: ${error.message}` });
      continue;
    }

    const byDoc = new Map<string, string[]>(slice.map((id) => [id, []]));
    for (const r of (data ?? []) as { document_id: string; collection_id: string }[]) {
      byDoc.get(r.document_id)?.push(r.collection_id);
    }

    const results = await Promise.all(
      slice.map(async (id) => {
        const { error: updateError } = await db
          .from("chunks")
          .update({ collection_ids: byDoc.get(id) ?? [] })
          .eq("org_id", orgId)
          .eq("document_id", id);
        return { id, error: updateError?.message ?? null };
      })
    );
    for (const r of results) {
      if (r.error) failed.push({ id: r.id, error: `Couldn't update its search index: ${r.error}` });
      else ok.push(r.id);
    }
  }

  return { ok, failed, remaining };
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

/** Validate `document_ids`: 1..BULK_MAX_IDS UUIDs, deduped and lower-cased. */
function parseDocumentIds(value: unknown): { ids: string[] } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) return { error: "document_ids must be a non-empty array" };
  if (value.length > BULK_MAX_IDS) return { error: `At most ${BULK_MAX_IDS} document_ids per request` };
  const ids = new Set<string>();
  for (const v of value) {
    if (typeof v !== "string" || !idPattern().test(v.trim())) return { error: "Every document id must be a UUID" };
    ids.add(v.trim().toLowerCase());
  }
  return { ids: [...ids] };
}

/**
 * Split the requested ids into documents of this org and the rest (reported
 * as failed). One org-scoped read.
 */
async function documentsInOrg(
  db: Db,
  orgId: string,
  ids: string[]
): Promise<{ found: string[]; failed: BulkFailure[] } | { error: string }> {
  const { data, error } = await db.from("documents").select("id").eq("org_id", orgId).in("id", ids);
  if (error) return { error: error.message };
  const inOrg = new Set(((data ?? []) as { id: string }[]).map((r) => r.id));
  return {
    found: ids.filter((id) => inOrg.has(id)),
    failed: ids.filter((id) => !inOrg.has(id)).map((id) => ({ id, error: "Document not found" })),
  };
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
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
  if (!body || typeof body !== "object") {
    return Response.json({ error: "document_id is required" }, { status: 400 });
  }

  if (body.document_ids !== undefined) {
    return addMany(admin.orgId, collectionId, body, startedAt + SYNC_BUDGET_MS);
  }

  const documentId = typeof body.document_id === "string" ? body.document_id : "";
  if (!documentId) {
    return Response.json({ error: "document_id is required" }, { status: 400 });
  }

  const db = supabaseAdmin();

  // Both sides must live in the caller's org before we link them. The two
  // checks are independent, so run them together; the 404 precedence
  // (collection first) is unchanged.
  const [collectionOk, docRes] = await Promise.all([
    collectionInOrg(db, admin.orgId, collectionId),
    db
      .from("documents")
      .select("id")
      .eq("id", documentId)
      .eq("org_id", admin.orgId)
      .maybeSingle(),
  ]);
  if (!collectionOk) {
    return Response.json({ error: "Collection not found" }, { status: 404 });
  }
  if (!docRes.data) return Response.json({ error: "Document not found" }, { status: 404 });

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

/** Bulk add, or move, into `collectionId`. */
async function addMany(
  orgId: string,
  collectionId: string,
  body: Record<string, unknown>,
  deadline: number
): Promise<Response> {
  const parsed = parseDocumentIds(body.document_ids);
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });

  const exclusive = body.exclusive === true;
  const rawFrom = body.from_collection_id;
  if (rawFrom !== undefined && rawFrom !== null && (typeof rawFrom !== "string" || !idPattern().test(rawFrom.trim()))) {
    return Response.json({ error: "from_collection_id must be a collection UUID" }, { status: 400 });
  }
  const from = typeof rawFrom === "string" ? rawFrom.trim().toLowerCase() : null;
  if (from && exclusive) {
    return Response.json({ error: "Send either from_collection_id or exclusive, not both" }, { status: 400 });
  }
  // Moving documents into the collection they are being moved from is a plain add.
  const moveFrom = from && from !== collectionId.toLowerCase() ? from : null;

  const db = supabaseAdmin();
  const [collectionOk, sourceOk, docs] = await Promise.all([
    collectionInOrg(db, orgId, collectionId),
    moveFrom ? collectionInOrg(db, orgId, moveFrom) : Promise.resolve(true),
    documentsInOrg(db, orgId, parsed.ids),
  ]);
  if (!collectionOk) return Response.json({ error: "Collection not found" }, { status: 404 });
  if (!sourceOk) return Response.json({ error: "Source collection not found" }, { status: 404 });
  if ("error" in docs) return Response.json({ error: docs.error }, { status: 500 });

  if (docs.found.length > 0) {
    // One upsert for every membership (PK (document_id, collection_id)): re-adding is a no-op.
    const { error } = await db.from("document_collections").upsert(
      docs.found.map((documentId) => ({ org_id: orgId, document_id: documentId, collection_id: collectionId })),
      { onConflict: "document_id,collection_id", ignoreDuplicates: true }
    );
    if (error) return Response.json({ error: error.message }, { status: 500 });

    if (moveFrom || exclusive) {
      const scoped = db.from("document_collections").delete().eq("org_id", orgId).in("document_id", docs.found);
      const { error: moveError } = await (moveFrom
        ? scoped.eq("collection_id", moveFrom)
        : scoped.neq("collection_id", collectionId));
      if (moveError) return Response.json({ error: moveError.message }, { status: 500 });
    }
  }

  const sync = await syncManyChunkCollectionIds(db, orgId, docs.found, deadline);
  return Response.json({
    ok: true,
    ids: sync.ok,
    failed: [...docs.failed, ...sync.failed],
    remaining: sync.remaining,
  });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  let admin;
  try {
    admin = await requireAdmin("collections:write");
  } catch (e) {
    return guard(e);
  }

  const { id: collectionId } = await ctx.params;
  const documentId = new URL(req.url).searchParams.get("document_id");
  if (!documentId) {
    // Bulk form: { document_ids } in the JSON body.
    let body: unknown = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }
    const ids = body && typeof body === "object" ? (body as { document_ids?: unknown }).document_ids : undefined;
    if (ids !== undefined) return removeMany(admin.orgId, collectionId, ids, startedAt + SYNC_BUDGET_MS);
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

/**
 * Bulk remove from `collectionId`. Idempotent: a document of this org that is
 * no longer in the collection counts as removed (so `remaining` can be resent).
 */
async function removeMany(orgId: string, collectionId: string, rawIds: unknown, deadline: number): Promise<Response> {
  const parsed = parseDocumentIds(rawIds);
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });

  const db = supabaseAdmin();
  const [collectionOk, docs] = await Promise.all([
    collectionInOrg(db, orgId, collectionId),
    documentsInOrg(db, orgId, parsed.ids),
  ]);
  if (!collectionOk) return Response.json({ error: "Collection not found" }, { status: 404 });
  if ("error" in docs) return Response.json({ error: docs.error }, { status: 500 });

  let removed = 0;
  if (docs.found.length > 0) {
    const { data, error } = await db
      .from("document_collections")
      .delete()
      .eq("org_id", orgId)
      .eq("collection_id", collectionId)
      .in("document_id", docs.found)
      .select("document_id");
    if (error) return Response.json({ error: error.message }, { status: 500 });
    removed = (data ?? []).length;
  }

  const sync = await syncManyChunkCollectionIds(db, orgId, docs.found, deadline);
  return Response.json({
    ok: true,
    removed,
    ids: sync.ok,
    failed: [...docs.failed, ...sync.failed],
    remaining: sync.remaining,
  });
}
