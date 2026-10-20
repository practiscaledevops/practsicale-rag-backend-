// Refresh one source identity, rather than appending another version of a call.
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { prepareChunkRows, type IngestParams, type IngestResult } from "@/lib/ingest";
import { redactPII } from "@/lib/redact";
import { currentCallEvidence } from "@/lib/call-status";

/** Publish authoritative scalar fields without waiting for embeddings. The
 * registration RPC creates missing calls and updates both identities atomically, rejecting older
 * source revisions. Preserve the indexed-body revision separately until the
 * durable worker finishes; never pretend the old body has been re-indexed. */
export async function syncSourceMetadata(db: SupabaseClient, params: {
  orgId: string; dataSourceId: string; recordId: string; metadata: Record<string, unknown>; title?: string;
}): Promise<number> {
  const meta = params.metadata;
  const summary = redactPII([
    "New call registered from the scoring app. Full report and transcript analysis are still indexing. This is factual call metadata, not a transcript.",
    `Consultant: ${meta.consultant_name ?? "Unknown"}`, `Prospect: ${meta.prospect_name ?? "Unknown"}`,
    `Practice: ${meta.practice_type ?? "Unknown"}`, `Recorded: ${meta.created_at ?? "Unknown"}`,
    currentCallEvidence("", "call_score", meta),
  ].join("\n")).slice(0,16000);
  const { data, error } = await db.rpc("publish_scoring_metadata", {
    p_org_id: params.orgId, p_source_id: params.dataSourceId, p_record_id: params.recordId,
    p_metadata: meta, p_title: params.title ?? "Call record", p_summary: summary,
  });
  if (error) throw Error("Scoring registration/metadata publication failed; durable worker will retry");
  return Array.isArray(data) ? data.length : 0;
}

export async function syncSourceDocument(db: SupabaseClient, params: IngestParams & { dataSourceId: string; recordId: string }): Promise<IngestResult> {
  const cleanText = redactPII(params.text);
  const hash = createHash("sha256").update(cleanText).digest("hex");
  const { data, error } = await db.from("documents").select("id,content_hash,chunks(count)")
    .eq("org_id", params.orgId).eq("data_source_id", params.dataSourceId)
    .eq("source_type", params.sourceType).eq("metadata->>source_record_id", params.recordId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Source identity lookup failed: ${error.message}`);
  const current = data?.[0];
  const unchangedBody = current?.content_hash === hash && (current.chunks as unknown as { count: number }[])?.[0]?.count > 0;
  const rows = unchangedBody ? null : await prepareChunkRows(db, {
    orgId: params.orgId, documentId: current?.id ?? randomUUID(), cleanText,
    sourceType: params.sourceType, metadata: params.metadata ?? {}, dataSourceId: params.dataSourceId,
    cols: params.collectionIds ?? [], chunkStrategy: params.chunkStrategy ?? "auto",
    contextPrefix: params.contextPrefix ?? null, contextualize: false,
    intelligenceClass: params.intelligenceClass, domain: params.domain, objectId: params.objectId,
  });
  const { data: result, error: syncError } = await db.rpc("sync_source_document", {
    p_org_id: params.orgId, p_source_id: params.dataSourceId, p_source_type: params.sourceType,
    p_record_id: params.recordId, p_content_hash: hash, p_title: params.title ?? null,
    p_metadata: params.metadata ?? {}, p_lane: { intelligence_class: params.intelligenceClass ?? "business_reality", domain: params.domain ?? "sales", object_id: params.objectId ?? null },
    p_chunks: rows,
  });
  if (syncError) throw new Error(`Source refresh failed (migration 0021 is required): ${syncError.message}`);
  const row = Array.isArray(result) ? result[0] : result;
  if (!row?.document_id) throw new Error("Source refresh returned no document");
  return { documentId: row.document_id, chunks: row.chunks, skipped: row.skipped };
}
