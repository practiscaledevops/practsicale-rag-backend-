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
// The core ingest logic lives in src/lib/ingest.ts (ingestOne) so this route and
// the pull connector runner share exactly one code path. This file only owns the
// HTTP surface + the per-upload ingestion_runs provenance row.

import { createHash, timingSafeEqual } from "crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { ingestOne } from "@/lib/ingest";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 60;

// Hard ceiling on the raw text a single ingest may carry. This endpoint buffers
// the whole body and embeds it, so an unbounded payload is a memory / cost / DoS
// vector — cap it before touching the DB. (~10 MB of UTF-16 chars.)
const MAX_TEXT_CHARS = 10_000_000;

/** Constant-time secret comparison that is also length-safe (hashes first). */
function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  // Write guard. This route runs with the SERVICE ROLE (bypasses RLS) and trusts
  // the caller-supplied orgId, so it MUST be a trusted server-to-server call.
  // FAIL CLOSED: if INGEST_SECRET is not configured, reject every request — a
  // missing env var must never silently open a service-role write endpoint.
  const secret = process.env.INGEST_SECRET;
  if (!secret) {
    return Response.json(
      { error: "Ingest endpoint is not configured" },
      { status: 503 }
    );
  }
  const provided = req.headers.get("x-ingest-secret") ?? "";
  if (!secretsMatch(provided, secret)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId, sourceType, title, text, uri, metadata, dataSourceId, collectionIds, trigger } =
    await req.json();

  if (!orgId || !sourceType || !text) {
    return Response.json({ error: "orgId, sourceType and text are required" }, { status: 400 });
  }
  if (typeof text !== "string" || text.length > MAX_TEXT_CHARS) {
    return Response.json(
      { error: `text must be a string no longer than ${MAX_TEXT_CHARS} characters` },
      { status: 413 }
    );
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
    console.error("[ingest] failed:", e);
    const message = e instanceof Error ? e.message : "ingest failed";
    await db
      .from("ingestion_runs")
      .update({ status: "error", error: message, finished_at: new Date().toISOString() })
      .eq("id", run?.id);
    return Response.json({ error: message }, { status: 500 });
  }
}
