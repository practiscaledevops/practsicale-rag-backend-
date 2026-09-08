// POST /api/v1/chat — grounded, cited, streamed chat over the key's permitted data.
//
// Auth:  Authorization: Bearer psk_...
// Scope: enforced by the key (capability 'chat' + source_types/data_sources/collections).
// Body:  { messages: [{role, content}], model?: "fast"|"recommended"|"max"|"<id>" }
//
// Response: an AI SDK data stream that interleaves THREE things a rich client can
// render live:
//   • status events   2:[{type:"status",stage,label,count}]   (planning→searching→…)
//   • a sources event  2:[{type:"sources",sources:[…],rewritten}]
//   • the answer text  0:"…"                                    (streamed tokens)
// Plain text clients still work — they just read the 0:"…" parts.
//
// Pipeline: the org's editable RagSettings + prompts drive every stage (see
// lib/pipeline). Ground-or-refuse returns a refusal WITHOUT a model call when
// nothing relevant is retrieved (guaranteed no hallucination, zero cost). After
// the stream we validate citations, optionally score faithfulness, and meter.
//
// Headers: x-model (resolved id), x-provider (anthropic|openai).

import { createDataStreamResponse, streamText, convertToCoreMessages, formatDataStreamPart } from "ai";
import { getModel } from "@/lib/llm";
import { buildContext } from "@/lib/prompts";
import { getActivePrompt } from "@/lib/prompts-db";
import { loadSettings } from "@/lib/settings";
import { runRetrieval } from "@/lib/pipeline";
import { validateCitations, checkFaithfulness } from "@/lib/faithfulness";
import { resolveContext, AuthError } from "@/lib/auth/context";
import { requireCapability, scopeFilters } from "@/lib/auth/scope";
import { checkRateLimit, rateLimitHeaders } from "@/lib/ratelimit";
import { costUsd } from "@/lib/pricing";
import { supabaseAdmin } from "@/lib/supabase";
import { isDemo } from "@/lib/demo/mode";
import { demoChatStreamResponse } from "@/lib/demo/stream";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 60;

const REFUSAL = "I don't have information about that in the knowledge available to me, so I can't answer.";

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

  const rl = checkRateLimit(ctx.key.id, ctx.key.rate_limit_per_min);
  if (!rl.ok) {
    return Response.json(
      { error: "Rate limit exceeded. Try again shortly." },
      { status: 429, headers: rateLimitHeaders(rl) }
    );
  }

  const { messages, model: tier } = await req.json();
  const history = (messages ?? []).filter(
    (m: any) => m?.role === "user" || m?.role === "assistant"
  );
  const lastUser = [...(messages ?? [])].reverse().find((m: any) => m.role === "user");
  const query: string = lastUser?.content ?? "";

  const [{ settings }, groundingPrompt] = await Promise.all([
    loadSettings(ctx.orgId),
    getActivePrompt(ctx.orgId, "chat"),
  ]);

  // Resolve the model up front so metering + headers agree on what ran.
  const resolvedModel = await getModel(tier ?? settings.generation.defaultTier);
  const modelId = resolvedModel.modelId;
  const provider = modelId.startsWith("claude") ? "anthropic" : "openai";
  const startedAt = Date.now();

  return createDataStreamResponse({
    headers: { "x-model": modelId, "x-provider": provider },
    onError: (error) => {
      console.error("[v1/chat] stream error:", error);
      return "The assistant hit an error while generating the answer. Please try again.";
    },
    execute: async (dataStream) => {
      dataStream.writeData({ type: "status", stage: "planning", label: "Understanding the request" });

      // Retrieval with live per-stage status events.
      const { chunks, rewritten } = await runRetrieval({
        orgId: ctx.orgId,
        query,
        history,
        scope: scopeFilters(ctx.key),
        settings,
        onStatus: (s) => dataStream.writeData({ type: "status", ...s }),
      });

      const retrievedIds = chunks.map((c) => c.id);
      // Surface the sources so the client can show/trace them.
      dataStream.writeData({
        type: "sources",
        rewritten,
        sources: chunks.map((c) => ({
          id: c.id,
          source_type: c.source_type ?? null,
          document_id: c.document_id,
          snippet: c.content.length > 200 ? c.content.slice(0, 200) + "…" : c.content,
        })),
      });

      // Ground-or-refuse: nothing retrieved ⇒ refuse without a model call.
      if (settings.features.groundOrRefuse && chunks.length === 0) {
        dataStream.writeData({ type: "status", stage: "retrieved", label: "No matching sources", count: 0 });
        dataStream.write(formatDataStreamPart("text", REFUSAL));
        void supabaseAdmin().from("usage_events").insert({
          org_id: ctx.orgId,
          api_key_id: ctx.key.id,
          kind: "chat",
          model: "none",
          tier: isTierName(tier) ? tier : settings.generation.defaultTier,
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
          latency_ms: Date.now() - startedAt,
          grounded: true,
          fabricated_citations: 0,
        });
        return;
      }

      const context = buildContext(chunks);
      dataStream.writeData({ type: "status", stage: "generating", label: "Writing the answer" });

      // Stable content first (system + context), user's messages last → caching-friendly.
      const result = streamText({
        model: resolvedModel,
        system: `${groundingPrompt}\n\nContext:\n${context}`,
        messages: convertToCoreMessages(messages ?? []),
        temperature: settings.generation.temperature,
        maxTokens: settings.generation.maxTokens,
        async onFinish({ usage, text }) {
          const inputTokens = usage?.promptTokens ?? 0;
          const outputTokens = usage?.completionTokens ?? 0;
          const { fabricated } = validateCitations(text ?? "", retrievedIds);
          let grounded: boolean | null = null;
          if (settings.features.faithfulnessCheck) {
            const fp = await getActivePrompt(ctx.orgId, "faithfulness");
            const verdict = await checkFaithfulness(context, text ?? "", fp, "fast");
            grounded = verdict.checked ? verdict.grounded : null;
          }
          void supabaseAdmin().from("usage_events").insert({
            org_id: ctx.orgId,
            api_key_id: ctx.key.id,
            kind: "chat",
            model: modelId,
            tier: isTierName(tier) ? tier : settings.generation.defaultTier,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cost_usd: costUsd(modelId, inputTokens, outputTokens),
            latency_ms: Date.now() - startedAt,
            grounded,
            fabricated_citations: fabricated.length,
          });
        },
      });

      result.mergeIntoDataStream(dataStream);
    },
  });
}
