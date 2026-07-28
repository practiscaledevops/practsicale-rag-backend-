// POST /api/ingest — ingest a document into the Brain (upload path).
//
// This is an ADMIN/WRITE endpoint. Until dashboard admin-session auth lands
// (Phase 2), it is guarded by a server secret header:
//     x-ingest-secret: <INGEST_SECRET>
// It uses the service role (bypasses RLS) and therefore MUST receive an explicit
// orgId from a trusted caller (the dashboard/server), never an anonymous client.
//
// Body: { orgId, sourceType, title, text, uri?, metadata?, dataSourceId?,
//         collectionIds?, trigger? }
//
// The core ingest logic lives in ingestOne() so BOTH this route and the pull
// connector runner (src/lib/connectors/pull.ts) share exactly one code path —
// same redaction, provenance, hash-based idempotency, and parent/child persist.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase";
import { chunkDocument, type Chunk } from "@/lib/chunking";
import { embedMany } from "@/lib/embeddings";
import { redactPII } from "@/lib/redact";
import { createHash } from "crypto";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 60;

export interface IngestParams {
  orgId: string;
  sourceType: string;
  title?: string | null;
  text: string;
  uri?: string | null;
  metadata?: Record<string, unknown>;
  dataSourceId?: string | null;
  collectionIds?: string[];
}

export interface IngestResult {
  documentId: string;
  /** Number of chunk rows written (parents + children). 0 when skipped. */
  chunks: number;
  /** True when an identical document (by content hash) already existed. */
  skipped: boolean;
}

/**
 * Ingest a single document: redact PII, skip if unchanged, insert the document
 * (+ collection memberships), then chunk -> embed -> persist. Structure-aware
 * chunking can emit PARENT chunks (full sections) alongside CHILD chunks; parents
 * are inserted first so children can carry a real parent_id.
 *
 * Throws on failure so the caller can record an error on its provenance row.
 * Does NOT write an ingestion_runs row — the caller owns provenance (one row per
 * upload for the route; one row per sync for the pull runner).
 */
export async function ingestOne(db: SupabaseClient, params: IngestParams): Promise<IngestResult> {
  const { orgId, sourceType, title, text, uri, metadata, dataSourceId } = params;
  const cols: string[] = Array.isArray(params.collectionIds) ? params.collectionIds : [];

  // Redact PII before it is embedded or stored (data contains personal info).
  const cleanText = redactPII(text);
  const contentHash = createHash("sha256").update(cleanText).digest("hex");

  // Skip if unchanged (content-hash change detection) -> idempotent ingest.
  const { data: existing } = await db
    .from("documents")
    .select("id")
    .eq("org_id", orgId)
    .eq("content_hash", contentHash)
    .maybeSingle();
  if (existing) {
    return { documentId: existing.id, chunks: 0, skipped: true };
  }

  const { data: doc, error } = await db
    .from("documents")
    .insert({
      org_id: orgId,
      source_type: sourceType,
      title: title ?? null,
      uri: uri ?? null,
      content_hash: contentHash,
      data_source_id: dataSourceId ?? null,
      metadata: metadata ?? {},
    })
    .select("id")
    .single();
  if (error || !doc) {
    throw new Error(error?.message ?? "document insert failed");
  }

  // Map document into any requested collections.
  if (cols.length > 0) {
    await db.from("document_collections").insert(
      cols.map((collection_id) => ({ org_id: orgId, document_id: doc.id, collection_id }))
    );
  }

  // Chunk -> embed -> persist, stamping scope columns so retrieval can filter fast.
  const chunks = chunkDocument(cleanText, sourceType, metadata ?? {});
  const vectors = await embedMany(chunks.map((c) => c.content));

  const baseRow = (c: Chunk, embedding: number[]) => ({
    org_id: orgId,
    document_id: doc.id,
    content: c.content,
    metadata: c.metadata,
    embedding,
    source_type: sourceType,
    data_source_id: dataSourceId ?? null,
    collection_ids: cols,
  });

  const withVec = chunks.map((c, i) => ({ chunk: c, embedding: vectors[i] }));
  const parents = withVec.filter((x) => x.chunk.metadata?.is_parent);
  const children = withVec.filter((x) => !x.chunk.metadata?.is_parent);

  // 1) Persist parents first and map each new id back to its local key. PostgREST
  //    returns inserted rows in input order, so we zip results with `parents`.
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

  // 2) Persist children with parent_id resolved from the local parentKey.
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

  return { documentId: doc.id, chunks: parents.length + children.length, skipped: false };
}

export async function POST(req: Request) {
  // Interim write guard (replaced by admin-session auth in Phase 2).
  const secret = process.env.INGEST_SECRET;
  if (secret && req.headers.get("x-ingest-secret") !== secret) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const {
    orgId,
    sourceType,
    title,
    text,
    uri,
    metadata,
    dataSourceId,
    collectionIds,
    trigger,
  } = await req.json();

  if (!orgId || !sourceType || !text) {
    return Response.json({ error: "orgId, sourceType and text are required" }, { status: 400 });
  }

  const db = supabaseAdmin();

  // Provenance row for this upload.
  const { data: run } = await db
    .from("ingestion_runs")
    .insert({
      org_id: orgId,
      data_source_id: dataSourceId ?? null,
      trigger: trigger ?? "upload",
      status: "running",
    })
    .select("id")
    .single();

  try {
    const res = await ingestOne(db, {
      orgId,
      sourceType,
      title,
      text,
      uri,
      metadata,
      dataSourceId,
      collectionIds,
    });

    await db
      .from("ingestion_runs")
      .update({
        status: "success",
        documents_ingested: res.skipped ? 0 : 1,
        documents_skipped: res.skipped ? 1 : 0,
        chunks_ingested: res.chunks,
        finished_at: new Date().toISOString(),
      })
      .eq("id", run?.id);

    return Response.json({ documentId: res.documentId, chunks: res.chunks, skipped: res.skipped });
  } catch (e) {
    const message = e instanceof Error ? e.message : "ingest failed";
    await db
      .from("ingestion_runs")
      .update({ status: "error", error: message, finished_at: new Date().toISOString() })
      .eq("id", run?.id);
    return Response.json({ error: message }, { status: 500 });
  }
}
