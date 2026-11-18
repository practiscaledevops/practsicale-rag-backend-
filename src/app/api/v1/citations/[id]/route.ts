import { resolveContext, AuthError } from "@/lib/auth/context";
import { narrowScope, requireCapability } from "@/lib/auth/scope";
import { recordedCallDate } from "@/lib/call-dates";
import { ghlOpportunityIdPattern, readGhlOpportunity } from "@/lib/connectors/ghl-opportunity";
import { payrollAccess } from "@/lib/connectors/payroll-report";
import { requireSourcePermission } from "@/lib/connectors/source-access";
import { callReviewInScope } from "@/lib/orchestrator";
import { checkRateLimit, rateLimitHeaders } from "@/lib/ratelimit";
import { loadSavedCitation } from "@/lib/saved-answer-followup";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestedId = (await params).id;
  const opportunityId = requestedId.startsWith("ghl-opportunity:") ? requestedId.slice("ghl-opportunity:".length) : null;
  const id = requestedId.toLowerCase();
  if (opportunityId !== null ? !ghlOpportunityIdPattern.test(opportunityId) :
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?$/.test(id)) {
    return Response.json({ error: "Invalid citation" }, { status: 400 });
  }
  let ctx;
  try {
    ctx = await resolveContext(req);
    requireCapability(ctx.key, "chat");
  } catch (error) {
    return Response.json({ error: "Access denied" }, { status: error instanceof AuthError ? error.status : 401 });
  }
  const rate = await checkRateLimit(ctx.key.id, ctx.key.rate_limit_per_min);
  const headers = { ...rateLimitHeaders(rate), "cache-control": "no-store" };
  if (!rate.ok) return Response.json({ error: "Rate limit exceeded" }, { status: 429, headers });

  const sourceTypes = new URL(req.url).searchParams.getAll("sourceType").slice(0, 50);
  const scope = narrowScope(ctx.key, { sourceTypes });
  if (opportunityId) {
    const unavailable = () => Response.json({ error: "Source unavailable" }, { status: 404, headers });
    if (!payrollAccess(ctx.orgId, ctx.key.id) || !callReviewInScope(scope)) return unavailable();
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(10000)]);
    try {
      await requireSourcePermission(req.headers.get("x-chatbot-user-token"), "pipeline.view", signal);
      const record = await readGhlOpportunity(opportunityId, signal);
      return Response.json({ id: requestedId, source_type: "ghl_opportunity", name: "GoHighLevel opportunity",
        opportunity: { id: record.id, status: record.status, pipelineId: record.pipelineId,
          stageId: record.pipelineStageId, lastStatusChangeAt: record.lastStatusChangeAt ?? null },
      }, { headers });
    } catch {
      return unavailable();
    }
  }
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(4000)]);
  const source = await loadSavedCitation(supabaseAdmin(), ctx.orgId, scope, id, signal)
    .catch(() => null);
  if (!source) return Response.json({ error: "Source unavailable" }, { status: 404, headers });
  const doc = source.documents;
  const isScorecard = source.source_type === "call_score";
  return Response.json({
    id: source.id,
    document_id: source.document_id,
    source_type: source.source_type,
    name: doc.title,
    date: doc.updated_at ?? doc.created_at,
    snippet: source.content.length > 600 ? source.content.slice(0, 600) + "…" : source.content,
    ...(isScorecard ? {
      scorecard: { callDate: recordedCallDate(doc), score: scoreOutOf100(doc.overall_score), band: doc.performance_band ?? null },
    } : {}),
  }, { headers });
}

function scoreOutOf100(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const score = Number(value);
  return Number.isFinite(score) && score >= 0 && score <= 100 ? score : null;
}
