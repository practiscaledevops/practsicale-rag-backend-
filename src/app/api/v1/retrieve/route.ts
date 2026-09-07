// POST /api/v1/retrieve — raw scoped retrieval (no generation).
// For consumer apps that do their own generation but want the Brain's grounded chunks.
//
// Auth:  Authorization: Bearer psk_...
// Scope: capability 'retrieve' + the key's data scope.
// Body:  { query: string, matchCount?: number, expandParents?: boolean }

import { hybridSearchScoped, expandParents } from "@/lib/retrieval";
import { rerank } from "@/lib/rerank";
import { resolveContext, AuthError } from "@/lib/auth/context";
import { requireCapability, scopeFilters } from "@/lib/auth/scope";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 30;

export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await resolveContext(req);
    requireCapability(ctx.key, "retrieve");
  } catch (e) {
    const err = e as AuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  const { query, matchCount, expandParents: expand } = await req.json();
  if (!query || typeof query !== "string") {
    return Response.json({ error: "query (string) is required" }, { status: 400 });
  }

  // Clamp the caller-supplied candidate pool: an unbounded matchCount would let a
  // key force an arbitrarily heavy DB scan (cost / DoS). 1..100, default 40.
  const rawMatch = Number(matchCount);
  const boundedMatch = Number.isFinite(rawMatch)
    ? Math.min(100, Math.max(1, Math.floor(rawMatch)))
    : 40;

  const candidates = await hybridSearchScoped({
    orgId: ctx.orgId,
    query,
    scope: scopeFilters(ctx.key),
    matchCount: boundedMatch,
  });
  const reranked = await rerank(query, candidates, 8);
  const results = expand ? await expandParents(reranked) : reranked;

  return Response.json({
    results: results.map((c) => ({
      id: c.id,
      content: c.content,
      source_type: c.source_type ?? null,
      document_id: c.document_id,
      metadata: c.metadata,
    })),
  });
}
