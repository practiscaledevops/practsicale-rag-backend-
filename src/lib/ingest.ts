// Shared ingest logic, used by BOTH the upload route (src/app/api/ingest/route.ts)
// and the pull-connector runner (src/lib/connectors/pull.ts) so there is exactly
// one code path: redaction, hash-based idempotency, and parent/child persistence.
//
// (This lives in lib/, not in the route file — Next.js route modules may only
// export HTTP handlers + a fixed set of config keys, so shared helpers must not
// be exported from route.ts.)

import type { SupabaseClient } from "@supabase/supabase-js";
import { chunkDocument, type Chunk } from "@/lib/chunking";
import { embedMany } from "@/lib/embeddings";
import { redactPII } from "@/lib/redact";
import { loadSettings } from "@/lib/settings";
import { getActivePrompt } from "@/lib/prompts-db";
import { contextualizeChunks } from "@/lib/contextualize";
import { createHash } from "crypto";
// Import the internal lib entry (not the package root) to avoid pdf-parse's
// module-level "debug" branch that tries to read a bundled test PDF from disk.
import pdfParse from "pdf-parse/lib/pdf-parse.js";

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
  const documentId = doc.id as string;

  try {
    // Map document into any requested collections.
    if (cols.length > 0) {
      await db.from("document_collections").insert(
        cols.map((collection_id) => ({ org_id: orgId, document_id: documentId, collection_id }))
      );
    }

    // Chunk -> (contextualize) -> embed -> persist, stamping scope columns so
    // retrieval can filter fast.
    const chunks = chunkDocument(cleanText, sourceType, metadata ?? {});

    // Contextual retrieval (Anthropic): generate a short blurb situating each
    // chunk in the document, prepended before embedding + full-text indexing.
    // Gated by the org's settings; graceful (empty contexts) on demo/outage/cap.
    const { settings } = await loadSettings(orgId, db);
    let contexts: string[] = chunks.map(() => "");
    if (settings.features.contextualRetrieval) {
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

    // Embed context + content together (contextual embeddings); store `content`
    // raw so citations/snippets stay clean, and `context` separately (the fts
    // generated column covers both — see migration 0010).
    const embedInputs = chunks.map((c, i) =>
      contexts[i] ? `${contexts[i]}\n\n${c.content}` : c.content
    );
    const vectors = await embedMany(embedInputs);

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
    });

    const withVec = chunks.map((c, i) => ({
      chunk: c,
      embedding: vectors[i],
      context: contexts[i] ?? "",
    }));
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

    return { documentId, chunks: parents.length + children.length, skipped: false };
  } catch (e) {
    // Roll back the orphan document (chunks + collection rows cascade).
    await db.from("documents").delete().eq("id", documentId).eq("org_id", orgId);
    throw e;
  }
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
