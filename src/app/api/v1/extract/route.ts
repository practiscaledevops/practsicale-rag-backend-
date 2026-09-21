// POST /api/v1/extract — source → text for consumer apps (spokes).
// Lets the chatbot hand the Brain a PDF, a screenshot, a voice note or a link
// its user attached and get the text back, using the same adapters as the
// Add-knowledge wizard (src/lib/ingest-adapters).
//
// Auth:  Authorization: Bearer psk_...
// Scope: capability 'chat' (extraction serves a conversation; nothing is stored).
// Body:  multipart/form-data  file=<upload> | url=<link>   or JSON { url: string }
// Reply: { name, kind: "url"|"youtube"|"pdf"|"audio"|"image"|"text", title, text, chars, truncated,
//          meta: { source_type?, source_platform?, source_url?, duration_s?, pages? } }
//        errors → { error } with 4xx/5xx (400 bad input · 413 too large · 415 unsupported ·
//        422 unreadable/login wall · 429 rate limit · 502/504 upstream).

import { resolveContext, AuthError } from "@/lib/auth/context";
import { requireCapability } from "@/lib/auth/scope";
import { checkRateLimit, rateLimitHeaders } from "@/lib/ratelimit";
import { handleExtractRequest } from "@/lib/ingest-adapters/request";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 120;

export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await resolveContext(req);
    requireCapability(ctx.key, "chat");
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

  return handleExtractRequest(req);
}
