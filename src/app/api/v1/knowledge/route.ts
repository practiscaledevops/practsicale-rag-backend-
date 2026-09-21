// GET /api/v1/knowledge — the "Brain map" for spokes: org-wide counts + a
// filtered, paged list of knowledge objects (no markdown; open one with
// GET /api/v1/knowledge/[ref]).
//
// Auth:  Authorization: Bearer psk_...  — capability 'chat' OR 'retrieve'.
// Query: ?class=&domain=&type=&q=&sensitive=1|0&includeArchive=0|1&limit=&offset=
//   q             matches ref / name / summary (ilike) or a tag
//   sensitive=0   hides calls, call scores, transcripts, KPI reports and the
//                 call-score team snapshot (default 1 = allowed)
//   includeArchive=1  also lists raw_archive objects (default excluded)
//   limit ≤ 50 (default 30), offset ≥ 0; sorted updated_at desc
// Returns: { counts, objects, page } — counts are org-wide, independent of filters.

import { supabaseAdmin } from "@/lib/supabase";
import { resolveContext, AuthError } from "@/lib/auth/context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/ratelimit";
import { scopeFilters } from "@/lib/auth/scope";
import { hasReadCapability, keyAllowsSensitive, listKnowledge, parseKnowledgeListParams, readErrorResponse } from "@/lib/knowledge-read";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 30;

export async function GET(req: Request) {
  let ctx;
  try {
    ctx = await resolveContext(req);
    if (!hasReadCapability(ctx.key)) throw new AuthError("This key is not permitted to read the Brain map (needs 'chat' or 'retrieve')", 403);
  } catch (e) {
    const err = e as AuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  const rl = checkRateLimit(ctx.key.id, ctx.key.rate_limit_per_min);
  if (!rl.ok) {
    return Response.json({ error: "Rate limit exceeded. Try again shortly." }, { status: 429, headers: rateLimitHeaders(rl) });
  }

  const params = parseKnowledgeListParams(new URL(req.url).searchParams);
  // The caller may only NARROW what the key allows: a key without call
  // material in its grant never lists sensitive objects, whatever it asks for.
  params.sensitive = params.sensitive && keyAllowsSensitive(ctx.key);
  try {
    const result = await listKnowledge(supabaseAdmin(), ctx.orgId, params, scopeFilters(ctx.key));
    return Response.json(result, { headers: { ...rateLimitHeaders(rl), "cache-control": "private, max-age=15" } });
  } catch (e) {
    return readErrorResponse(e);
  }
}
