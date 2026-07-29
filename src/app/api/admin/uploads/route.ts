// POST /api/admin/uploads — ingest an uploaded document (admin/session path).
//
// The dashboard reads plain text from a .md/.txt file in the browser and POSTs
// it here as JSON. This route is the session-guarded sibling of /api/ingest: it
// resolves org_id SERVER-SIDE from the admin session (never the request body),
// writes one ingestion_runs provenance row, and calls the SHARED ingestOne() so
// upload and pull-connector ingest walk exactly one code path (same redaction,
// hashing, and parent/child persistence).
//
// Uploaded text is treated as DATA, never instructions (redaction + structural
// separation happen inside ingestOne / the prompt layer).
//
// PDF: extraction is not wired yet (no server-side PDF lib). The dashboard marks
// PDFs "coming soon"; when a PDF text-extraction step lands it should produce the
// `text` this route already expects — no shape change needed here.

import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
import { ingestOne } from "@/lib/ingest";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 60;

const SOURCE_TYPES = ["transcript", "call_score", "coaching", "document"];

export async function POST(req: Request) {
  let admin;
  try {
    // Uploading writes a document into the knowledge base.
    admin = await requireAdmin("documents:write");
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sourceType = typeof body.sourceType === "string" ? body.sourceType.trim() : "";
  const text = typeof body.text === "string" ? body.text : "";
  const title =
    typeof body.title === "string" && body.title.trim() ? body.title.trim() : null;
  const uri = typeof body.uri === "string" && body.uri.trim() ? body.uri.trim() : null;
  const metadata =
    body.metadata && typeof body.metadata === "object"
      ? (body.metadata as Record<string, unknown>)
      : {};
  const collectionIds = Array.isArray(body.collectionIds)
    ? (body.collectionIds as unknown[]).filter((x): x is string => typeof x === "string")
    : [];

  // --- Validation -----------------------------------------------------------
  if (!SOURCE_TYPES.includes(sourceType)) {
    return Response.json(
      { error: `sourceType must be one of: ${SOURCE_TYPES.join(", ")}` },
      { status: 400 }
    );
  }
  if (!text.trim()) {
    return Response.json({ error: "text is empty" }, { status: 400 });
  }

  const db = supabaseAdmin();

  // Provenance row for this upload (one per uploaded file).
  const { data: run } = await db
    .from("ingestion_runs")
    .insert({ org_id: admin.orgId, trigger: "upload", status: "running" })
    .select("id")
    .single();

  try {
    const res = await ingestOne(db, {
      orgId: admin.orgId,
      sourceType,
      title,
      text,
      uri,
      metadata: { ...metadata, uploaded_by: admin.email },
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
