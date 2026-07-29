// GET    /api/admin/documents/[id] — one document + every chunk (the inspector).
// PATCH  /api/admin/documents/[id] — edit the title (and optionally metadata).
// DELETE /api/admin/documents/[id] — delete the document (chunks cascade).
//
// org_id is resolved SERVER-SIDE from the admin session (never from the request)
// and every query is filtered by it, so a request can only ever read or mutate a
// document within the caller's own tenant. A foreign id simply matches nothing.
//
// EMBEDDINGS ARE NEVER SENT TO THE CLIENT. The chunk vectors (1024 floats each)
// are heavy and are not useful in the UI, so we only confirm their PRESENCE: a
// second, cheap `embedding is not null` query returns just the ids that carry an
// embedding, and each chunk is flagged `has_embedding` from that set. The vector
// numbers themselves never leave Postgres.

import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

// The fixed embedding width for this project (text-embedding-3-large truncated).
const EMBEDDING_DIM = 1024;

function guard(e: unknown): Response {
  const err = e as AdminAuthError;
  return Response.json({ error: err.message }, { status: err.status ?? 401 });
}

// Shape returned to the client for one chunk. NO raw embedding — presence only.
interface ChunkDTO {
  id: string;
  content: string;
  token_count: number | null;
  /** Cheap ~4-chars/token estimate captured at ingest (metadata.tokens). */
  approx_tokens: number | null;
  source_type: string | null;
  is_parent: boolean;
  parent_id: string | null;
  heading: string | null;
  collection_ids: string[];
  has_embedding: boolean;
}

type ChunkRow = {
  id: string;
  content: string;
  token_count: number | null;
  source_type: string | null;
  parent_id: string | null;
  collection_ids: string[] | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

/**
 * Decide whether a document can be re-ingested. Re-ingest re-runs the chunk +
 * embed pipeline over the document's SOURCE TEXT — which the schema only retains
 * when either (a) it was explicitly stashed in metadata.source_text, or (b) the
 * source is a single-record type (call_score / coaching) whose one chunk IS the
 * serialized text verbatim. For split documents / transcripts the original text
 * is not recoverable losslessly, so re-ingest is disabled with an explanation.
 */
function reingestAvailability(
  sourceType: string,
  metadata: Record<string, unknown> | null,
  chunkCount: number
): { available: boolean; reason: string } {
  const stored =
    metadata && typeof metadata.source_text === "string" && metadata.source_text.trim();
  if (stored) {
    return {
      available: true,
      reason: "Re-runs chunking and embedding on the retained source text.",
    };
  }
  if ((sourceType === "call_score" || sourceType === "coaching") && chunkCount >= 1) {
    return {
      available: true,
      reason: "Re-runs chunking and embedding from this record's stored chunk.",
    };
  }
  return {
    available: false,
    reason:
      "The original text wasn't retained at ingest, so this document can't be re-processed. Re-upload the file to refresh its chunks.",
  };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let admin;
  try {
    admin = await requireAdmin("documents:read");
  } catch (e) {
    return guard(e);
  }

  const { id } = await ctx.params;
  const db = supabaseAdmin();

  // 1) The document itself, tenant-scoped.
  const { data: doc, error: docErr } = await db
    .from("documents")
    .select(
      "id, title, source_type, uri, content_hash, data_source_id, metadata, created_at, updated_at"
    )
    .eq("id", id)
    .eq("org_id", admin.orgId)
    .maybeSingle();

  if (docErr) return Response.json({ error: docErr.message }, { status: 500 });
  if (!doc) return Response.json({ error: "Document not found" }, { status: 404 });

  // 2) In parallel: the chunks (no embedding column), the ids that HAVE an
  //    embedding, the doc's collection ids, and the data source name (if any).
  const [chunksRes, embeddedRes, membershipRes, sourceRes] = await Promise.all([
    db
      .from("chunks")
      .select(
        "id, content, token_count, source_type, parent_id, collection_ids, metadata, created_at"
      )
      .eq("org_id", admin.orgId)
      .eq("document_id", id)
      // Parents are inserted before their children; created_at asc keeps sections
      // and their splits in a stable, readable order.
      .order("created_at", { ascending: true }),
    db
      .from("chunks")
      .select("id")
      .eq("org_id", admin.orgId)
      .eq("document_id", id)
      .not("embedding", "is", null),
    db
      .from("document_collections")
      .select("collection_id")
      .eq("org_id", admin.orgId)
      .eq("document_id", id),
    doc.data_source_id
      ? db
          .from("data_sources")
          .select("id, name")
          .eq("id", doc.data_source_id as string)
          .eq("org_id", admin.orgId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  const anyErr =
    chunksRes.error ?? embeddedRes.error ?? membershipRes.error ?? sourceRes.error;
  if (anyErr) return Response.json({ error: anyErr.message }, { status: 500 });

  const embeddedIds = new Set(
    ((embeddedRes.data as { id: string }[]) ?? []).map((r) => r.id)
  );

  const rows = (chunksRes.data as ChunkRow[]) ?? [];
  const chunks: ChunkDTO[] = rows.map((c) => {
    const md = (c.metadata ?? {}) as Record<string, unknown>;
    return {
      id: c.id,
      content: c.content,
      token_count: c.token_count,
      approx_tokens: typeof md.tokens === "number" ? (md.tokens as number) : null,
      source_type: c.source_type,
      is_parent: md.is_parent === true,
      parent_id: c.parent_id,
      heading: typeof md.heading === "string" ? (md.heading as string) : null,
      collection_ids: Array.isArray(c.collection_ids) ? c.collection_ids : [],
      has_embedding: embeddedIds.has(c.id),
    };
  });

  // 3) Resolve the doc's collection ids to readable {id,name} for badges. The
  //    chunk-level collection_ids are a subset of these, so the client can map
  //    uuids -> names from this one list.
  const collectionIds = (
    (membershipRes.data as { collection_id: string }[]) ?? []
  ).map((r) => r.collection_id);

  let collections: { id: string; name: string }[] = [];
  if (collectionIds.length > 0) {
    const { data: colRows } = await db
      .from("collections")
      .select("id, name")
      .eq("org_id", admin.orgId)
      .in("id", collectionIds);
    collections = (colRows as { id: string; name: string }[]) ?? [];
  }

  const metadata = (doc.metadata ?? {}) as Record<string, unknown>;

  const document = {
    id: doc.id as string,
    title: (doc.title as string | null) ?? null,
    source_type: doc.source_type as string,
    uri: (doc.uri as string | null) ?? null,
    content_hash: (doc.content_hash as string | null) ?? null,
    data_source_id: (doc.data_source_id as string | null) ?? null,
    data_source: (sourceRes.data as { id: string; name: string } | null) ?? null,
    metadata,
    created_at: doc.created_at as string,
    updated_at: doc.updated_at as string,
    chunk_count: chunks.length,
    embedded_count: chunks.filter((c) => c.has_embedding).length,
    embedding_dim: EMBEDDING_DIM,
    collections,
    reingest: reingestAvailability(doc.source_type as string, metadata, chunks.length),
  };

  return Response.json({ document, chunks });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let admin;
  try {
    admin = await requireAdmin("documents:write");
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

  // Build a partial update. `title` can be cleared to NULL with an empty string.
  // `metadata` (when a plain object) replaces the stored metadata wholesale — note
  // this edits only the DOCUMENT row, not the per-chunk metadata already embedded.
  const patch: { title?: string | null; metadata?: Record<string, unknown> } = {};

  if ("title" in body) {
    if (typeof body.title !== "string") {
      return Response.json({ error: "title must be a string" }, { status: 400 });
    }
    const t = body.title.trim();
    patch.title = t === "" ? null : t;
  }

  if ("metadata" in body) {
    if (
      body.metadata === null ||
      typeof body.metadata !== "object" ||
      Array.isArray(body.metadata)
    ) {
      return Response.json(
        { error: "metadata must be a JSON object" },
        { status: 400 }
      );
    }
    patch.metadata = body.metadata as Record<string, unknown>;
  }

  if (Object.keys(patch).length === 0) {
    return Response.json({ error: "Nothing to update" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("documents")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("org_id", admin.orgId) // tenant scope
    .select("id, title, metadata, updated_at")
    .maybeSingle();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data) return Response.json({ error: "Document not found" }, { status: 404 });

  return Response.json({ document: data });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let admin;
  try {
    admin = await requireAdmin("documents:write");
  } catch (e) {
    return guard(e);
  }

  const { id } = await ctx.params;
  const db = supabaseAdmin();

  // Scope the delete to this org — a foreign id matches nothing (count 0). Chunks
  // and collection memberships cascade via FK `on delete cascade`.
  const { error, count } = await db
    .from("documents")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("org_id", admin.orgId);

  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!count) return Response.json({ error: "Document not found" }, { status: 404 });

  return Response.json({ ok: true });
}
