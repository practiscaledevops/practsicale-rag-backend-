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

import { supabaseAdmin } from "@/lib/supabase";
import { chunkDocument } from "@/lib/chunking";
import { embedMany } from "@/lib/embeddings";
import { redactPII } from "@/lib/redact";
import { createHash } from "crypto";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 60;

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

  // Redact PII before it is embedded or stored (data contains personal info).
  const cleanText = redactPII(text);
  const contentHash = createHash("sha256").update(cleanText).digest("hex");

  // Provenance row for this ingest.
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

  // Skip if unchanged (content-hash change detection).
  const { data: existing } = await db
    .from("documents")
    .select("id")
    .eq("org_id", orgId)
    .eq("content_hash", contentHash)
    .maybeSingle();
  if (existing) {
    await db
      .from("ingestion_runs")
      .update({ status: "success", documents_skipped: 1, finished_at: new Date().toISOString() })
      .eq("id", run?.id);
    return Response.json({ documentId: existing.id, chunks: 0, skipped: true });
  }

  const { data: doc, error } = await db
    .from("documents")
    .insert({
      org_id: orgId,
      source_type: sourceType,
      title,
      uri,
      content_hash: contentHash,
      data_source_id: dataSourceId ?? null,
      metadata: metadata ?? {},
    })
    .select("id")
    .single();
  if (error || !doc) {
    await db
      .from("ingestion_runs")
      .update({ status: "error", error: error?.message ?? "insert failed", finished_at: new Date().toISOString() })
      .eq("id", run?.id);
    return Response.json({ error: error?.message ?? "insert failed" }, { status: 500 });
  }

  // Map document into any requested collections.
  const cols: string[] = Array.isArray(collectionIds) ? collectionIds : [];
  if (cols.length > 0) {
    await db.from("document_collections").insert(
      cols.map((collection_id) => ({ org_id: orgId, document_id: doc.id, collection_id }))
    );
  }

  // Chunk -> embed -> insert, stamping scope columns so retrieval can filter fast.
  const chunks = chunkDocument(cleanText, sourceType, metadata ?? {});
  const vectors = await embedMany(chunks.map((c) => c.content));
  const rows = chunks.map((c, i) => ({
    org_id: orgId,
    document_id: doc.id,
    content: c.content,
    metadata: c.metadata,
    embedding: vectors[i],
    source_type: sourceType,
    data_source_id: dataSourceId ?? null,
    collection_ids: cols,
  }));
  const { error: cErr } = await db.from("chunks").insert(rows);
  if (cErr) {
    await db
      .from("ingestion_runs")
      .update({ status: "error", error: cErr.message, finished_at: new Date().toISOString() })
      .eq("id", run?.id);
    return Response.json({ error: cErr.message }, { status: 500 });
  }

  await db
    .from("ingestion_runs")
    .update({
      status: "success",
      documents_ingested: 1,
      chunks_ingested: rows.length,
      finished_at: new Date().toISOString(),
    })
    .eq("id", run?.id);

  return Response.json({ documentId: doc.id, chunks: rows.length });
}
