// POST /api/admin/uploads — ingest a single uploaded file (dashboard drag-and-drop path).
//
// Accepts multipart/form-data with ONE `file` field per request. The dashboard
// client loops over the dropped files and POSTs them one at a time so it can show
// live per-file status (queued -> uploading -> processing -> done/error).
//
// org_id is resolved SERVER-SIDE from the admin session (never the request) and
// the `documents:write` grant is enforced. We read the raw bytes here and turn
// them into text:
//   - .pdf              -> pdfToText(buffer) (shared extractor in @/lib/ingest)
//   - .md/.markdown/.txt -> decoded as UTF-8
// then hand the text to the SHARED ingestOne() so upload and pull-connector
// ingest walk exactly one code path (same redaction, hashing, parent/child
// persistence). One ingestion_runs provenance row is written per upload.
//
// Uploaded content is treated as DATA, never instructions (redaction + structural
// separation happen inside ingestOne / the prompt layer).
//
// Request:  multipart/form-data, field `file` = the uploaded file.
// Response: { documentId, chunks, skipped }  on success (200)
//           { error }                          on failure (4xx/5xx)

import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
import { ingestOne, pdfToText } from "@/lib/ingest";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
// Contextual retrieval (up to 200 chunks × an LLM call) plus embeddings for a
// large PDF takes minutes; a timeout mid-ingest used to leave an orphan document.
export const maxDuration = 300;

// Extensions we can turn into text here. PDFs go through pdfToText(); the rest
// are read as UTF-8. Anything else is rejected before touching the DB.
const TEXT_EXTENSIONS = [".md", ".markdown", ".txt", ".text"];
const ALLOWED_LABEL = ".md, .markdown, .txt, .pdf";

// Hard upload ceiling. file.arrayBuffer() buffers the whole file into memory, so
// an unbounded upload is a memory/DoS vector — cap it BEFORE reading any bytes.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

export async function POST(req: Request) {
  let admin;
  try {
    // Uploading writes a document into the knowledge base.
    admin = await requireAdmin("documents:write");
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  // --- Pull the file out of the multipart form ------------------------------
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "No file provided (field 'file')" }, { status: 400 });
  }

  // Optional classification the uploader applies to the batch (all fields
  // optional; backward compatible with the plain drag-and-drop path). These land
  // in the document's metadata + collection membership so the Documents table and
  // governance views are populated at ingest.
  const str = (v: FormDataEntryValue | null): string => (typeof v === "string" ? v.trim() : "");
  const collectionId = str(form.get("collection_id"));
  const category = str(form.get("category"));
  const department = str(form.get("department"));
  const access = str(form.get("access"));
  const owner = str(form.get("owner"));
  const reviewDate = str(form.get("review_date"));
  const tagsRaw = str(form.get("tags"));
  const titleOverride = str(form.get("title"));

  const name = file.name || "upload";
  const ext = extOf(name);
  const mime = file.type || "application/octet-stream";

  // Reject oversized uploads before buffering them into memory (413).
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json(
      {
        error: `File is too large (${Math.ceil(file.size / (1024 * 1024))} MB). Maximum is ${
          MAX_UPLOAD_BYTES / (1024 * 1024)
        } MB.`,
      },
      { status: 413 }
    );
  }

  // --- Turn raw bytes into text --------------------------------------------
  let text: string;
  try {
    if (ext === ".pdf") {
      const buffer = Buffer.from(await file.arrayBuffer());
      text = await pdfToText(buffer);
    } else if (TEXT_EXTENSIONS.includes(ext)) {
      text = await file.text();
    } else {
      return Response.json(
        { error: `Unsupported file type '${ext || name}'. Allowed: ${ALLOWED_LABEL}` },
        { status: 415 }
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not read file";
    return Response.json({ error: message }, { status: 422 });
  }

  if (!text.trim()) {
    return Response.json(
      { error: "No readable text found in the file" },
      { status: 422 }
    );
  }

  const db = supabaseAdmin();

  // Provenance row for this upload (one per uploaded file).
  const { data: run } = await db
    .from("ingestion_runs")
    .insert({ org_id: admin.orgId, trigger: "upload", status: "running" })
    .select("id")
    .single();

  try {
    const tags = tagsRaw
      ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean)
      : undefined;

    const res = await ingestOne(db, {
      orgId: admin.orgId,
      sourceType: "document",
      title: titleOverride || name,
      text,
      metadata: {
        mime,
        filename: name,
        uploaded_by: admin.email,
        ...(category ? { category } : {}),
        ...(department ? { department } : {}),
        ...(access ? { confidentiality: access } : {}),
        ...(owner ? { source_owner: owner } : {}),
        ...(reviewDate ? { review_date: reviewDate } : {}),
        ...(tags && tags.length ? { tags } : {}),
      },
      collectionIds: collectionId ? [collectionId] : undefined,
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

    // Link the run to its document for the inspector's run history (best-effort;
    // skipped until migration 0016 adds the column).
    if (run?.id && res.documentId) {
      await db
        .from("ingestion_runs")
        .update({ document_id: res.documentId })
        .eq("id", run.id)
        .then(
          ({ error }) => error && !/document_id/i.test(error.message) && console.error("[upload] run link failed:", error.message),
          () => {}
        );
    }

    return Response.json({
      documentId: res.documentId,
      chunks: res.chunks,
      skipped: res.skipped,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "ingest failed";
    await db
      .from("ingestion_runs")
      .update({ status: "error", error: message, finished_at: new Date().toISOString() })
      .eq("id", run?.id);
    return Response.json({ error: message }, { status: 500 });
  }
}
