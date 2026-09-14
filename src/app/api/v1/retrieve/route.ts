// POST /api/v1/retrieve — raw scoped retrieval (no generation).
// For consumer apps that do their own generation but want the Brain's grounded chunks.
//
// Auth:  Authorization: Bearer psk_...
// Scope: capability 'retrieve' + the key's data scope.
// Body:  { query: string, matchCount?: number, expandParents?: boolean }
//
// Runs the same settings-driven pipeline as /api/v1/chat (query rewrite → route →
// hybrid search → rerank → parent expansion), so retrieval quality is identical.

import { runRetrieval } from "@/lib/pipeline";
import { loadSettings } from "@/lib/settings";
import { resolveContext, AuthError } from "@/lib/auth/context";
import { requireCapability, scopeFilters } from "@/lib/auth/scope";
import { checkRateLimit, rateLimitHeaders } from "@/lib/ratelimit";

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

  const rl = checkRateLimit(ctx.key.id, ctx.key.rate_limit_per_min);
  if (!rl.ok) {
    return Response.json(
      { error: "Rate limit exceeded. Try again shortly." },
      { status: 429, headers: rateLimitHeaders(rl) }
    );
  }

  const { query, matchCount, expandParents: expand } = await req.json();
  if (!query || typeof query !== "string") {
    return Response.json({ error: "query (string) is required" }, { status: 400 });
  }

  const { settings } = await loadSettings(ctx.orgId);

  // A caller-supplied matchCount overrides the configured candidate pool, but is
  // clamped: an unbounded value would let a key force an arbitrarily heavy scan.
  const rawMatch = Number(matchCount);
  const boundedMatch = Number.isFinite(rawMatch)
    ? Math.min(200, Math.max(1, Math.floor(rawMatch)))
    : settings.retrieval.matchCount;

  // Per-request override of the two knobs a caller legitimately controls.
  const effective = {
    ...settings,
    retrieval: {
      ...settings.retrieval,
      matchCount: boundedMatch,
      expandParents: typeof expand === "boolean" ? expand : settings.retrieval.expandParents,
    },
  };

  const { chunks, effectiveQuery, rewritten, confidence } = await runRetrieval({
    orgId: ctx.orgId,
    query,
    scope: scopeFilters(ctx.key),
    settings: effective,
  });

  return Response.json({
    query: effectiveQuery,
    rewritten,
    confidence,
    results: chunks.map((c) => ({
      id: c.id,
      content: c.content,
      source_type: c.source_type ?? null,
      document_id: c.document_id,
      metadata: c.metadata,
      score: c.score ?? null,
    })),
  });
}
