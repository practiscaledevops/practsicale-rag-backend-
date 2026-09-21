// GET /api/v1/knowledge/[ref] — open one knowledge object a spoke cited:
// the object (with bounded compiled markdown), its relationships (both
// directions, resolved to ref/name), the learning records linked to it, and
// its chunk count.
//
// Auth:  Authorization: Bearer psk_...  — capability 'chat' OR 'retrieve'.
// Path:  a stable ref (MG-001, BR-SAL-003 …) or the object's uuid.
// Query: ?sensitive=1|0 — with 0, a sensitive object answers 404 and sensitive
//        neighbours are dropped from `relationships`.
// Returns: { object, relationships, learning, chunks }

import { supabaseAdmin } from "@/lib/supabase";
import { resolveContext, AuthError } from "@/lib/auth/context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/ratelimit";
import { scopeFilters } from "@/lib/auth/scope";
import { hasReadCapability, getKnowledgeDetail, keyAllowsSensitive, parseSensitiveFlag, readErrorResponse } from "@/lib/knowledge-read";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 30;

type Ctx = { params: Promise<{ ref: string }> };

export async function GET(req: Request, routeCtx: Ctx) {
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

  const { ref } = await routeCtx.params;
  // Next already decodes route params; a second decode throws on a literal "%".
  const key = (ref ?? "").trim().slice(0, 64);
  if (!key) return Response.json({ error: "ref is required" }, { status: 400 });
  // Sensitive objects: the caller may only NARROW what the key allows.
  const sensitive = parseSensitiveFlag(new URL(req.url).searchParams) && keyAllowsSensitive(ctx.key);

  try {
    const result = await getKnowledgeDetail(supabaseAdmin(), ctx.orgId, key, { sensitive, scope: scopeFilters(ctx.key) });
    if (!result) return Response.json({ error: "Not found" }, { status: 404, headers: rateLimitHeaders(rl) });
    return Response.json(result, { headers: { ...rateLimitHeaders(rl), "cache-control": "private, max-age=15" } });
  } catch (e) {
    return readErrorResponse(e);
  }
}
