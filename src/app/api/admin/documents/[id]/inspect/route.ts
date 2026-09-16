// GET /api/admin/documents/[id]/inspect — the document inspector payload for the
// Collections control center: the document's chunks (text, contextual summary,
// position, parent) in order. Admin-gated, org-scoped. Never selects the 1024-d
// embedding vector (heavy + must not leak); index status is derived from whether
// each chunk exists (the pipeline embeds on ingest).

import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  const { id } = await ctx.params;
  const db = supabaseAdmin();

  const { data: doc, error: docErr } = await db
    .from("documents")
    .select("id, title, source_type, uri, content_hash, metadata, created_at, updated_at")
    .eq("id", id)
    .eq("org_id", admin.orgId)
    .maybeSingle();
  if (docErr) return Response.json({ error: docErr.message }, { status: 500 });
  if (!doc) return Response.json({ error: "Document not found" }, { status: 404 });

  // Chunks in document order. Select only what the inspector renders — never the
  // embedding vector.
  const { data: chunkRows } = await db
    .from("chunks")
    .select("id, content, context, metadata, parent_id, token_count, created_at")
    .eq("org_id", admin.orgId)
    .eq("document_id", id)
    .order("created_at", { ascending: true })
    .limit(2000);

  // Per-chunk retrieval stats (migration 0015). Fetch this doc's retrieval events
  // and aggregate in JS. Graceful: missing table → empty stats.
  const retrievalByChunk = new Map<string, { count: number; cited: number; last: string; scoreSum: number; scoreN: number }>();
  let docLastRetrieved: string | null = null;
  let docCitations = 0;
  try {
    const { data: ev } = await db
      .from("chunk_retrievals")
      .select("chunk_id, score, cited, created_at")
      .eq("org_id", admin.orgId)
      .eq("document_id", id)
      .order("created_at", { ascending: false })
      .limit(5000);
    for (const r of (ev ?? []) as { chunk_id: string; score: number | null; cited: boolean; created_at: string }[]) {
      const s = retrievalByChunk.get(r.chunk_id) ?? { count: 0, cited: 0, last: r.created_at, scoreSum: 0, scoreN: 0 };
      s.count += 1;
      if (r.cited) { s.cited += 1; docCitations += 1; }
      if (r.created_at > s.last) s.last = r.created_at;
      if (typeof r.score === "number") { s.scoreSum += r.score; s.scoreN += 1; }
      retrievalByChunk.set(r.chunk_id, s);
      if (!docLastRetrieved || r.created_at > docLastRetrieved) docLastRetrieved = r.created_at;
    }
  } catch {
    /* table not present yet */
  }
  const totalRetrievals = [...retrievalByChunk.values()].reduce((n, s) => n + s.count, 0);

  const chunks = ((chunkRows ?? []) as Record<string, unknown>[]).map((c) => {
    const st = retrievalByChunk.get(String(c.id));
    return {
      id: String(c.id),
      content: String(c.content ?? ""),
      context: (c.context as string) ?? null,
      parentId: (c.parent_id as string) ?? null,
      tokenCount: (c.token_count as number) ?? null,
      isParent: Boolean((c.metadata as { is_parent?: boolean } | null)?.is_parent),
      retrievals: st?.count ?? 0,
      citations: st?.cited ?? 0,
      lastRetrieved: st?.last ?? null,
      avgScore: st && st.scoreN > 0 ? Math.round((st.scoreSum / st.scoreN) * 1000) / 1000 : null,
    };
  });

  // Per-document processing runs (migration 0016 adds ingestion_runs.document_id).
  let runs: { status: string; trigger: string; chunks: number; error: string | null; startedAt: string; finishedAt: string | null }[] = [];
  try {
    const { data: runRows } = await db
      .from("ingestion_runs")
      .select("status, trigger, chunks_ingested, error, started_at, finished_at")
      .eq("org_id", admin.orgId)
      .eq("document_id", id)
      .order("started_at", { ascending: false })
      .limit(20);
    runs = ((runRows ?? []) as Record<string, unknown>[]).map((r) => ({
      status: String(r.status ?? ""),
      trigger: String(r.trigger ?? ""),
      chunks: Number(r.chunks_ingested ?? 0),
      error: (r.error as string) ?? null,
      startedAt: String(r.started_at ?? ""),
      finishedAt: (r.finished_at as string) ?? null,
    }));
  } catch {
    /* column not present yet */
  }

  return Response.json({
    stats: { totalRetrievals, citations: docCitations, lastRetrieved: docLastRetrieved },
    runs,
    document: {
      id: String((doc as Record<string, unknown>).id),
      title: (doc as Record<string, unknown>).title ?? null,
      sourceType: String((doc as Record<string, unknown>).source_type ?? "document"),
      uri: (doc as Record<string, unknown>).uri ?? null,
      contentHash: (doc as Record<string, unknown>).content_hash ?? null,
      metadata: (doc as Record<string, unknown>).metadata ?? {},
      createdAt: (doc as Record<string, unknown>).created_at ?? null,
      updatedAt: (doc as Record<string, unknown>).updated_at ?? null,
    },
    chunks,
  });
}
