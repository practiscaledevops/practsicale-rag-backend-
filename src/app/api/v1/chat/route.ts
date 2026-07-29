// POST /api/v1/chat — grounded, cited, streamed chat over the key's permitted data.
//
// Auth:  Authorization: Bearer psk_...
// Scope: enforced by the key (capability 'chat' + source_types/data_sources/collections).
// Body:  { messages: [{role, content}], model?: "fast"|"recommended"|"max"|"<id>" }
//
// Response: the Vercel AI SDK data stream (toDataStreamResponse). Its `finish`
// part carries token usage for the consumer app. We ALSO surface the resolved
// model on two response headers so a consumer can label the turn without parsing
// the stream:
//   x-model     resolved model id (e.g. "claude-opus-4-8")
//   x-provider  "anthropic" | "openai"
// On finish we meter the call into usage_events (org from ctx, key from ctx.key).

import { streamText, convertToCoreMessages } from "ai";
import { modelForTier } from "@/lib/llm";
import { hybridSearchScoped, expandParents } from "@/lib/retrieval";
import { rerank } from "@/lib/rerank";
import { GROUNDED_SYSTEM, buildContext } from "@/lib/prompts";
import { resolveContext, AuthError } from "@/lib/auth/context";
import { requireCapability, scopeFilters } from "@/lib/auth/scope";
import { costUsd } from "@/lib/pricing";
import { supabaseAdmin } from "@/lib/supabase";
import { isDemo } from "@/lib/demo/mode";
import { demoChatStreamResponse } from "@/lib/demo/stream";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 60;

function isTierName(v: unknown): v is "fast" | "recommended" | "max" {
  return v === "fast" || v === "recommended" || v === "max";
}

export async function POST(req: Request) {
  // DEMO MODE: no key/model needed — return a canned grounded stream.
  if (isDemo()) {
    const body = await req.json().catch(() => ({}));
    const last = [...(body?.messages ?? [])].reverse().find((m: any) => m.role === "user");
    return demoChatStreamResponse(last?.content ?? "");
  }

  let ctx;
  try {
    ctx = await resolveContext(req);
    requireCapability(ctx.key, "chat");
  } catch (e) {
    const err = e as AuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  const { messages, model: tier } = await req.json();
  const lastUser = [...(messages ?? [])].reverse().find((m: any) => m.role === "user");
  const query: string = lastUser?.content ?? "";

  // Retrieve within the key's scope -> rerank -> expand to parent context.
  // Wider candidate pool (60) than the default so rerank has more to work with.
  const candidates = await hybridSearchScoped({
    orgId: ctx.orgId,
    query,
    scope: scopeFilters(ctx.key),
    matchCount: 60,
  });
  const top = await rerank(query, candidates, 8);
  const context = buildContext(await expandParents(top));

  // Resolve the concrete model (tier name OR explicit id) once, so metering and
  // the response headers agree on exactly what ran.
  const resolvedModel = modelForTier(tier);
  const modelId = resolvedModel.modelId;
  const provider = modelId.startsWith("claude") ? "anthropic" : "openai";
  const startedAt = Date.now();

  // Stable content first (system + context), user's messages last -> caching-friendly.
  const result = streamText({
    model: resolvedModel,
    system: `${GROUNDED_SYSTEM}\n\nContext:\n${context}`,
    messages: convertToCoreMessages(messages ?? []),
    onFinish({ usage }) {
      // Fire-and-forget metering. usage_events is org-scoped (ctx.orgId) and
      // attributed to the calling key (ctx.key.id). Never blocks the response.
      const inputTokens = usage?.promptTokens ?? 0;
      const outputTokens = usage?.completionTokens ?? 0;
      void supabaseAdmin()
        .from("usage_events")
        .insert({
          org_id: ctx.orgId,
          api_key_id: ctx.key.id,
          kind: "chat",
          model: modelId,
          tier: isTierName(tier) ? tier : "recommended",
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cost_usd: costUsd(modelId, inputTokens, outputTokens),
          latency_ms: Date.now() - startedAt,
        });
    },
  });

  // Keep the AI SDK data stream (finish part carries usage) and add model headers.
  return result.toDataStreamResponse({
    headers: { "x-model": modelId, "x-provider": provider },
  });
}
