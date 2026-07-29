// POST /api/admin/documents/[id]/reingest — rebuild one document's chunks.
//
// Re-ingest re-runs the SAME processing pipeline (redact -> chunk -> embed) over
// the document's source text and swaps in fresh chunks, IN PLACE, keeping the
// document's id (and therefore its URL, collection membership, and provenance)
// stable. Useful after the chunking or embedding logic changes.
//
// It reuses the shared primitives (redactPII, chunkDocument, embedMany) and
// mirrors ingestOne's parent-before-child persistence, rather than calling
// ingestOne directly: ingestOne always INSERTS a new document (new id) and would
// be short-circuited by its own content-hash dedupe, since re-ingesting identical
// text hashes the same. Rebuilding in place avoids both problems.
//
// SOURCE TEXT RECOVERY: the schema does not store raw uploads, so re-ingest is
// only possible when the text is recoverable — either stashed at ingest in
// metadata.source_text, or (for call_score / coaching) the single chunk whose
// content IS the serialized record. Otherwise we return 422 and the UI disables
// the button. GET's `reingest.available` flag is computed from the same rules.
//
// org_id is resolved SERVER-SIDE from the admin session; every query is scoped to
// it, so a request can only ever touch a document in the caller's own tenant.

import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
import { chunkDocument, type Chunk } from "@/lib/chunking";
import { embedMany } from "@/lib/embeddings";
import { redactPII } from "@/lib/redact";
import { createHash } from "crypto";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 60;

function guard(e: unknown): Response {
  const err = e as AdminAuthError;
  return Response.json({ error: err.message }, { status: err.status ?? 401 });
}

/**
 * Recover the source text for re-ingest, or null if it isn't retained. Mirrors
 * reingestAvailability() in the sibling GET route.
 */
function recoverSourceText(
  sourceType: string,
  metadata: Record<string, unknown>,
  chunkContents: string[]
): string | null {
  const stored =
    typeof metadata.source_text === "string" ? metadata.source_text.trim() : "";
  if (stored) return stored;

  // call_score / coaching ingest exactly one chunk whose content is the verbatim
  // serialized record — reconstructing it is lossless.
  if (sourceType === "call_score" || sourceType === "coaching") {
    const joined = chunkContents.join("\n\n").trim();
    return joined || null;
  }
  return null;
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let admin;
  try {
    admin = await requireAdmin("documents:write");
  } catch (e) {
    return guard(e);
  }

  const { id } = await ctx.params;
  const db = supabaseAdmin();

  // 1) Load the document (tenant-scoped) and everything needed to rebuild it.
  const { data: doc, error: docErr } = await db
    .from("documents")
    .select("id, source_type, title, uri, metadata, data_source_id")
    .eq("id", id)
    .eq("org_id", admin.orgId)
    .maybeSingle();

  if (docErr) return Response.json({ error: docErr.message }, { status: 500 });
  if (!doc) return Response.json({ error: "Document not found" }, { status: 404 });

  const sourceType = doc.source_type as string;
  const metadata = ((doc.metadata ?? {}) as Record<string, unknown>) || {};

  // 2) Existing chunks (for recovery) and the document's collection membership.
  const [existingRes, membershipRes] = await Promise.all([
    db
      .from("chunks")
      .select("content")
      .eq("org_id", admin.orgId)
      .eq("document_id", id)
      .order("created_at", { ascending: true }),
    db
      .from("document_collections")
      .select("collection_id")
      .eq("org_id", admin.orgId)
      .eq("document_id", id),
  ]);

  if (existingRes.error) return Response.json({ error: existingRes.error.message }, { status: 500 });
  if (membershipRes.error) return Response.json({ error: membershipRes.error.message }, { status: 500 });

  const chunkContents = ((existingRes.data as { content: string }[]) ?? []).map((c) => c.content);
  const collectionIds = ((membershipRes.data as { collection_id: string }[]) ?? []).map(
    (r) => r.collection_id
  );

  // 3) Recover the source text or refuse (the UI disables the button in this case).
  const sourceText = recoverSourceText(sourceType, metadata, chunkContents);
  if (!sourceText) {
    return Response.json(
      {
        error:
          "The original text wasn't retained for this document, so it can't be re-processed.",
        code: "no_source_text",
      },
      { status: 422 }
    );
  }

  // 4) Redact + chunk + embed FIRST, before mutating anything. If the embedding
  //    provider errors here, the document's current chunks are left untouched.
  const cleanText = redactPII(sourceText);
  const contentHash = createHash("sha256").update(cleanText).digest("hex");

  // Don't let a stashed source_text blob leak into every chunk's metadata.
  const chunkMeta: Record<string, unknown> = { ...metadata };
  delete chunkMeta.source_text;

  let chunks: Chunk[];
  let vectors: number[][];
  try {
    chunks = chunkDocument(cleanText, sourceType, chunkMeta);
    vectors = await embedMany(chunks.map((c) => c.content));
  } catch (e) {
    const message = e instanceof Error ? e.message : "embedding failed";
    return Response.json({ error: message }, { status: 502 });
  }

  // 5) We are now committed to rebuilding. Open a provenance row.
  const { data: run } = await db
    .from("ingestion_runs")
    .insert({
      org_id: admin.orgId,
      data_source_id: (doc.data_source_id as string | null) ?? null,
      trigger: "manual",
      status: "running",
    })
    .select("id")
    .single();

  const baseRow = (c: Chunk, embedding: number[]) => ({
    org_id: admin.orgId,
    document_id: id,
    content: c.content,
    metadata: c.metadata,
    embedding,
    source_type: sourceType,
    data_source_id: (doc.data_source_id as string | null) ?? null,
    collection_ids: collectionIds,
  });

  try {
    // Swap the chunks: drop the old set, then insert the fresh one. (Embeddings
    // are already computed above, so this window is pure, fast DB work.)
    const { error: delErr } = await db
      .from("chunks")
      .delete()
      .eq("org_id", admin.orgId)
      .eq("document_id", id);
    if (delErr) throw new Error(delErr.message);

    const withVec = chunks.map((c, i) => ({ chunk: c, embedding: vectors[i] }));
    const parents = withVec.filter((x) => x.chunk.metadata?.is_parent);
    const children = withVec.filter((x) => !x.chunk.metadata?.is_parent);

    // Parents first, so children can carry a real parent_id (see ingestOne).
    const parentIdByKey = new Map<string, string>();
    if (parents.length > 0) {
      const { data: pRows, error: pErr } = await db
        .from("chunks")
        .insert(parents.map((p) => baseRow(p.chunk, p.embedding)))
        .select("id");
      if (pErr) throw new Error(pErr.message);
      (pRows ?? []).forEach((row: { id: string }, i: number) => {
        const key = parents[i]?.chunk.key;
        if (key) parentIdByKey.set(key, row.id);
      });
    }

    const childRows = children.map((x) => {
      const row = baseRow(x.chunk, x.embedding) as Record<string, unknown>;
      const pk = x.chunk.parentKey;
      row.parent_id = pk ? parentIdByKey.get(pk) ?? null : null;
      return row;
    });
    if (childRows.length > 0) {
      const { error: cErr } = await db.from("chunks").insert(childRows);
      if (cErr) throw new Error(cErr.message);
    }

    const total = parents.length + children.length;

    // Refresh the document's hash + updated_at to reflect the rebuild.
    await db
      .from("documents")
      .update({ content_hash: contentHash, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("org_id", admin.orgId);

    await db
      .from("ingestion_runs")
      .update({
        status: "success",
        documents_ingested: 1,
        chunks_ingested: total,
        finished_at: new Date().toISOString(),
      })
      .eq("id", run?.id);

    return Response.json({ documentId: id, chunks: total, reingested: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "re-ingest failed";
    await db
      .from("ingestion_runs")
      .update({ status: "error", error: message, finished_at: new Date().toISOString() })
      .eq("id", run?.id);
    return Response.json({ error: message }, { status: 500 });
  }
}
