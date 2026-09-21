// Shared ingest logic, used by BOTH the upload route (src/app/api/ingest/route.ts)
// and the pull-connector runner (src/lib/connectors/pull.ts) so there is exactly
// one code path: redaction, hash-based idempotency, and parent/child persistence.
//
// (This lives in lib/, not in the route file — Next.js route modules may only
// export HTTP handlers + a fixed set of config keys, so shared helpers must not
// be exported from route.ts.)

import type { SupabaseClient } from "@supabase/supabase-js";
import { chunkDocument, chunkKnowledgeObject, type Chunk } from "@/lib/chunking";
import { embedMany } from "@/lib/embeddings";
import { redactPII } from "@/lib/redact";
import { loadSettings } from "@/lib/settings";
import { getActivePrompt } from "@/lib/prompts-db";
import { contextualizeChunks } from "@/lib/contextualize";
import { createHash } from "crypto";
// Import the internal lib entry (not the package root) to avoid pdf-parse's
// module-level "debug" branch that tries to read a bundled test PDF from disk.
import pdfParse from "pdf-parse/lib/pdf-parse.js";

/** Operating-Intelligence lane identity stamped on a document and its chunks. */
export interface LaneIdentity {
  intelligenceClass?: string | null;
  domain?: string | null;
  objectId?: string | null;
}

export interface IngestParams extends LaneIdentity {
  orgId: string;
  sourceType: string;
  title?: string | null;
  text: string;
  uri?: string | null;
  metadata?: Record<string, unknown>;
  dataSourceId?: string | null;
  collectionIds?: string[];
  /**
   * "knowledge_object": chunk by heading section (semantic; every chunk inherits
   * the object metadata). Default "auto" picks the strategy by source type.
   */
  chunkStrategy?: "auto" | "knowledge_object";
  /**
   * Deterministic context line prepended to every chunk's embed/FTS input (the
   * object's identity, e.g. "MG-001 Source of Energy · playbook/management/
   * framework/accountability"). When set, the LLM contextualize step is skipped.
   */
  contextPrefix?: string | null;
  /** Force contextual retrieval on/off for this document (default: org setting). */
  contextualize?: boolean;
  /** Skip content-hash dedup (a compiled object legitimately overlaps its raw source). */
  allowDuplicate?: boolean;
}

export interface IngestResult {
  documentId: string;
  /** Number of chunk rows written (parents + children). 0 when skipped. */
  chunks: number;
  /** True when an identical document (by content hash) already existed. */
  skipped: boolean;
}

/** Lane columns for an insert/update, only when a lane identity is provided
 *  (so legacy callers keep the pre-0017 row shape). */
function laneColumns(lane: LaneIdentity): Record<string, unknown> {
  if (lane.intelligenceClass == null && lane.domain == null && lane.objectId == null) return {};
  return {
    intelligence_class: lane.intelligenceClass ?? null,
    domain: lane.domain ?? null,
    object_id: lane.objectId ?? null,
  };
}

interface PersistContext extends LaneIdentity {
  orgId: string;
  documentId: string;
  cleanText: string;
  sourceType: string;
  metadata: Record<string, unknown>;
  dataSourceId: string | null;
  cols: string[];
  chunkStrategy: "auto" | "knowledge_object";
  contextPrefix: string | null;
  contextualize?: boolean;
}

/**
 * Chunk -> (contextualize) -> embed -> persist for an existing document row,
 * stamping scope + lane columns so retrieval can filter fast. Structure-aware
 * chunking can emit PARENT chunks (full sections) alongside CHILD chunks;
 * parents are inserted first so children can carry a real parent_id.
 */
async function persistChunks(db: SupabaseClient, ctx: PersistContext): Promise<number> {
  const { orgId, documentId, cleanText, sourceType, metadata, dataSourceId, cols } = ctx;

  const chunks =
    ctx.chunkStrategy === "knowledge_object"
      ? chunkKnowledgeObject(cleanText, metadata)
      : chunkDocument(cleanText, sourceType, metadata);
  if (chunks.length === 0) return 0;

  // Context per chunk: a deterministic identity line for compiled objects, or
  // the LLM-generated situating blurb (Anthropic contextual retrieval) for
  // ordinary documents. Gated by the org's settings; graceful on demo/outage/cap.
  let contexts: string[] = chunks.map(() => "");
  if (ctx.contextPrefix) {
    contexts = chunks.map((c) => {
      const section = typeof c.metadata?.section === "string" ? c.metadata.section : "";
      return section ? `${ctx.contextPrefix} · Section: ${section}` : ctx.contextPrefix!;
    });
  } else {
    const { settings } = await loadSettings(orgId, db);
    const on = ctx.contextualize ?? settings.features.contextualRetrieval;
    if (on) {
      const systemPrompt = await getActivePrompt(orgId, "context_generation");
      contexts = await contextualizeChunks(
        cleanText,
        chunks.map((c) => c.content),
        {
          systemPrompt,
          tier: settings.contextual.tier,
          concurrency: settings.contextual.concurrency,
          maxChunksPerDoc: settings.contextual.maxChunksPerDoc,
        }
      );
    }
  }

  // Embed context + content together (contextual embeddings); store `content`
  // raw so citations/snippets stay clean, and `context` separately (the fts
  // generated column covers both — see migration 0010).
  const embedInputs = chunks.map((c, i) => (contexts[i] ? `${contexts[i]}\n\n${c.content}` : c.content));
  const vectors = await embedMany(embedInputs);

  const lane = laneColumns(ctx);
  const baseRow = (c: Chunk, embedding: number[], context: string) => ({
    org_id: orgId,
    document_id: documentId,
    content: c.content,
    context: context || null,
    metadata: c.metadata,
    embedding,
    source_type: sourceType,
    data_source_id: dataSourceId ?? null,
    collection_ids: cols,
    ...lane,
  });

  const withVec = chunks.map((c, i) => ({ chunk: c, embedding: vectors[i], context: contexts[i] ?? "" }));
  const parents = withVec.filter((x) => x.chunk.metadata?.is_parent);
  const children = withVec.filter((x) => !x.chunk.metadata?.is_parent);

  // 1) Persist parents first and map each new id back to its local key. PostgREST
  //    returns inserted rows in input order, so we zip results with `parents`.
  const parentIdByKey = new Map<string, string>();
  if (parents.length > 0) {
    const { data: pRows, error: pErr } = await db
      .from("chunks")
      .insert(parents.map((p) => baseRow(p.chunk, p.embedding, p.context)))
      .select("id");
    if (pErr) throw new Error(pErr.message);
    (pRows ?? []).forEach((row: { id: string }, i: number) => {
      const key = parents[i]?.chunk.key;
      if (key) parentIdByKey.set(key, row.id);
    });
  }

  // 2) Persist children with parent_id resolved from the local parentKey.
  const childRows = children.map((x) => {
    const row = baseRow(x.chunk, x.embedding, x.context) as Record<string, unknown>;
    const pk = x.chunk.parentKey;
    row.parent_id = pk ? parentIdByKey.get(pk) ?? null : null;
    return row;
  });
  if (childRows.length > 0) {
    const { error: cErr } = await db.from("chunks").insert(childRows);
    if (cErr) throw new Error(cErr.message);
  }
  return parents.length + children.length;
}

/**
 * Ingest a single document: redact PII, skip if unchanged, insert the document
 * (+ collection memberships), then chunk -> embed -> persist.
 *
 * Transactional-ish: if anything after the document insert fails (e.g. the
 * embedding provider erroring), the just-inserted document is deleted before the
 * error is rethrown — otherwise an orphan document keeps its content_hash and
 * every future ingest of the same content would skip forever, never producing
 * chunks. Does NOT write an ingestion_runs row — the caller owns provenance.
 */
export async function ingestOne(db: SupabaseClient, params: IngestParams): Promise<IngestResult> {
  const { orgId, sourceType, title, text, uri, metadata, dataSourceId } = params;
  const cols: string[] = Array.isArray(params.collectionIds) ? params.collectionIds : [];

  const cleanText = redactPII(text);
  const contentHash = createHash("sha256").update(cleanText).digest("hex");

  // Skip if unchanged (content-hash change detection) -> idempotent ingest.
  if (!params.allowDuplicate) {
    const { data: existing } = await db
      .from("documents")
      .select("id")
      .eq("org_id", orgId)
      .eq("content_hash", contentHash)
      .maybeSingle();
    if (existing) {
      return { documentId: existing.id, chunks: 0, skipped: true };
    }
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
      ...laneColumns(params),
    })
    .select("id")
    .single();
  if (error || !doc) {
    throw new Error(error?.message ?? "document insert failed");
  }
  const documentId = doc.id as string;

  try {
    // Map document into any requested collections.
    if (cols.length > 0) {
      await db.from("document_collections").insert(
        cols.map((collection_id) => ({ org_id: orgId, document_id: documentId, collection_id }))
      );
    }

    const chunks = await persistChunks(db, {
      orgId,
      documentId,
      cleanText,
      sourceType,
      metadata: metadata ?? {},
      dataSourceId: dataSourceId ?? null,
      cols,
      chunkStrategy: params.chunkStrategy ?? "auto",
      contextPrefix: params.contextPrefix ?? null,
      contextualize: params.contextualize,
      intelligenceClass: params.intelligenceClass,
      domain: params.domain,
      objectId: params.objectId,
    });

    return { documentId, chunks, skipped: false };
  } catch (e) {
    // Roll back the orphan document (chunks + collection rows cascade).
    await db.from("documents").delete().eq("id", documentId).eq("org_id", orgId);
    throw e;
  }
}

export interface ReingestParams extends LaneIdentity {
  orgId: string;
  documentId: string;
  text: string;
  title?: string | null;
  /** Merged over the document's existing metadata. */
  metadata?: Record<string, unknown>;
  chunkStrategy?: "auto" | "knowledge_object";
  contextPrefix?: string | null;
  contextualize?: boolean;
}

/**
 * Replace a document's content in place (same document id): used when a
 * knowledge object is ENRICHED or its markdown edited. Re-hashes, updates the
 * row, deletes the old chunks and persists new ones — so relationships, run
 * history and retrieval logs that point at the document keep working.
 */
export async function reingestDocument(db: SupabaseClient, params: ReingestParams): Promise<IngestResult> {
  const { orgId, documentId } = params;
  const { data: doc, error } = await db
    .from("documents")
    .select("id, source_type, metadata, data_source_id")
    .eq("id", documentId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error || !doc) throw new Error(error?.message ?? "document not found");

  const cleanText = redactPII(params.text);
  const contentHash = createHash("sha256").update(cleanText).digest("hex");
  const metadata = { ...((doc.metadata as Record<string, unknown>) ?? {}), ...(params.metadata ?? {}) };

  const { data: colRows } = await db
    .from("document_collections")
    .select("collection_id")
    .eq("document_id", documentId);
  const cols = ((colRows ?? []) as { collection_id: string }[]).map((r) => r.collection_id);

  const { error: uErr } = await db
    .from("documents")
    .update({
      content_hash: contentHash,
      metadata,
      ...(params.title !== undefined ? { title: params.title } : {}),
      ...laneColumns(params),
    })
    .eq("id", documentId)
    .eq("org_id", orgId);
  if (uErr) throw new Error(uErr.message);

  const { error: dErr } = await db.from("chunks").delete().eq("document_id", documentId).eq("org_id", orgId);
  if (dErr) throw new Error(dErr.message);

  const chunks = await persistChunks(db, {
    orgId,
    documentId,
    cleanText,
    sourceType: (doc.source_type as string) ?? "document",
    metadata,
    dataSourceId: (doc.data_source_id as string | null) ?? null,
    cols,
    chunkStrategy: params.chunkStrategy ?? "auto",
    contextPrefix: params.contextPrefix ?? null,
    contextualize: params.contextualize,
    intelligenceClass: params.intelligenceClass,
    domain: params.domain,
    objectId: params.objectId,
  });
  return { documentId, chunks, skipped: false };
}

/**
 * Extract plain text from a PDF file buffer using pdf-parse.
 *
 * ingestOne() keeps its text-in contract — it never touches binary. Binary
 * decoding lives HERE so the upload route can turn an uploaded PDF into text
 * before calling ingestOne(). Returns the document's concatenated text (empty
 * string if the PDF has no extractable text layer, e.g. a scanned image PDF —
 * OCR is out of scope).
 */
export async function pdfToText(buffer: Buffer): Promise<string> {
  const parsed = await pdfParse(buffer);
  return parsed.text ?? "";
}

/**
 * Convenience dispatcher for the upload route: decode a file buffer to text
 * based on its MIME type. PDFs go through pdf-parse; everything else is treated
 * as UTF-8 text (MD, TXT, etc.). ingestOne() still expects already-extracted
 * text — this is just the decode step in front of it.
 */
export async function extractText(buffer: Buffer, mime?: string | null): Promise<string> {
  if (mime === "application/pdf") return pdfToText(buffer);
  return buffer.toString("utf-8");
}
