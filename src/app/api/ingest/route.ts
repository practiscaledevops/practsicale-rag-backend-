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

import { supabaseAdmin } from "@/lib/supabase";
import { ingestOne } from "@/lib/ingest";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 60;

export async function POST(req: Request) {
  // Interim write guard (replaced by admin-session auth in Phase 2).
  const secret = process.env.INGEST_SECRET;
  if (secret && req.headers.get("x-ingest-secret") !== secret) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId, sourceType, title, text, uri, metadata, dataSourceId, collectionIds, trigger } =
    await req.json();

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
