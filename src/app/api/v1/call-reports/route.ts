// Exact, model-independent live call reports. Long polling returns as soon as
// scoped metadata changes; unchanged reports never fetch transcripts or models.
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { resolveContext, AuthError } from "@/lib/auth/context";
import { requireCapability, narrowScope, narrowSourceTypes } from "@/lib/auth/scope";
import { KNOWLEDGE_SCOPE_IDS, knowledgeScopeDef } from "@/lib/knowledge-scopes";
import { capabilityGates, callReviewInScope } from "@/lib/orchestrator";
import { supabaseAdmin } from "@/lib/supabase";
import { checkRateLimit, rateLimitHeaders } from "@/lib/ratelimit";
import { callerTimeZone, resolveTimeZone, todayIn } from "@/lib/timezone";
import { applyCallReviewFilter, parseCallReviewFilter, knownConsultants, fetchCallsByFilter } from "@/lib/call-review";
import { renderCallReport, wantsStructuredCallReport } from "@/lib/call-report";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 30;
const schema = z.object({
  query: z.string().trim().min(1).max(8000), timeZone: z.string().max(100).optional(),
  version: z.string().max(128).optional(), waitMs: z.number().int().min(0).max(20_000).default(0),
  capabilities: z.array(z.string().max(100)).max(300).optional(),
  sourceTypes: z.array(z.string().max(100)).max(100).optional(), collectionIds: z.array(z.string().uuid()).max(50).optional(),
  knowledgeScope: z.enum(KNOWLEDGE_SCOPE_IDS).optional(),
});
const headers = { "cache-control": "private, no-store" };

export async function POST(req: Request) {
  try {
    const ctx = await resolveContext(req);
    requireCapability(ctx.key, "chat");
    const rl = checkRateLimit(`call-reports:${ctx.key.id}`, ctx.key.rate_limit_per_min);
    if (!rl.ok) return Response.json({ error: "Too many live report requests" }, { status: 429, headers: { ...headers, ...rateLimitHeaders(rl) } });
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Invalid live report request" }, { status: 400, headers });
    const body = parsed.data;
    const knowledge = knowledgeScopeDef(body.knowledgeScope);
    const scope = narrowSourceTypes(narrowScope(ctx.key, body), knowledge.retrieval.sourceTypes);
    if (!capabilityGates(body.capabilities).callReview || !callReviewInScope(scope) || knowledge.retrieval.callReview === "off") {
      return Response.json({ error: "Call reports are unavailable in this scope" }, { status: 403, headers });
    }
    if (!wantsStructuredCallReport(body.query)) return Response.json({ error: "An operational call report query is required" }, { status: 400, headers });
    const db = supabaseAdmin();
    const timeZone = resolveTimeZone(callerTimeZone(body.timeZone));
    const filter = parseCallReviewFilter(body.query, { referenceDate: todayIn(timeZone), timeZone, knownConsultants: await knownConsultants(db, ctx.orgId) });
    const revision = async () => {
      const { data, count, error } = await applyCallReviewFilter(db.from("documents").select("id,updated_at", { count: "exact" }), ctx.orgId, filter, timeZone)
        .order("updated_at", { ascending: false }).order("id", { ascending: true }).limit(1);
      if (error || count == null) throw Error("Call revision lookup failed");
      const latest = data?.[0] ?? null;
      return { version: createHash("sha256").update(JSON.stringify({ org: ctx.orgId, filter, timeZone, count, latest })).digest("base64url"), updatedAt: latest?.updated_at ?? null };
    };
    const deadline = Date.now() + body.waitMs;
    let current = await revision();
    while (current.version === body.version && Date.now() < deadline && !req.signal.aborted) {
      await delay(Math.min(1000, Math.max(1, deadline - Date.now())), undefined, { signal: req.signal });
      current = await revision();
    }
    if (current.version === body.version) return Response.json({ unchanged: true, ...current, checkedAt: new Date().toISOString() }, { headers });
    // Read a coherent report: if a write overlaps the roster read, retry rather
    // than labelling an old roster with the revision of newer metadata.
    for (let attempt = 0; attempt < 3; attempt++) {
      const roster = await fetchCallsByFilter(db, ctx.orgId, filter, { maxCalls: 0, maxTokens: 0, metadataOnly: true, timeZone });
      if (roster.complete === false) throw Error("Incomplete call roster");
      const after = await revision();
      if (after.version === current.version) return Response.json({ ...current, content: renderCallReport(roster.scorecard, filter, timeZone), count: roster.totalMatched, filter, timeZone, checkedAt: new Date().toISOString() }, { headers });
      current = after;
    }
    throw Error("Call roster changed during read");
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status, headers });
    if (req.signal.aborted) return new Response(null, { status: 499, headers });
    console.error("[live-call-report] lookup failed");
    return Response.json({ error: "Live call data is temporarily unavailable. The saved report is historical." }, { status: 503, headers });
  }
}
