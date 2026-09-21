// POST /api/v1/chat — grounded, cited, streamed chat over the key's permitted data.
//
// Auth:  Authorization: Bearer psk_...
// Scope: enforced by the key (capability 'chat' + source_types/data_sources/collections).
// Body:  { messages: [{role, content}], model?: "fast"|"recommended"|"max"|"smart"|"deep"|"<id>",
//          mode?: "<work mode | alias | auto>", outputType?, sourceTypes?, collectionIds?,
//          directives?, attachments?: [{name, text}] }
//
// Response: an AI SDK data stream that interleaves what a rich client can render live:
//   • status events   2:[{type:"status",stage,label,count,mode?,lanes?}]
//   • a mode event    2:[{type:"mode",mode,label,auto,intent}]         (Auto → detected expert)
//   • a route event   2:[{type:"route",requested,tier,model}]           (Smart Route / Deep)
//   • a sources event 2:[{type:"sources",sources:[…],rewritten,confidence,lanes}]
//   • a learning event 2:[{type:"learning_candidate",…}]              (save as Org Learning?)
//   • the answer text 0:"…"
//
// Pipeline (Operating Intelligence): understand the request → work-mode retrieval
// policy → search the intelligence lanes (Reality / Learning / Playbooks / Platform)
// with soft metadata boosts → relationship expansion → rerank → lane-grouped,
// authority-labelled context (+ Performance Memory numbers) → reason in order
// (reality → learning → standards → playbooks). Ground-or-refuse returns a refusal
// WITHOUT a model call when nothing relevant is retrieved. After the stream we
// validate citations, optionally score faithfulness, meter, and log.
//
// Headers: x-model (resolved id), x-provider (anthropic|openai).

import { createDataStreamResponse, streamText, convertToCoreMessages, formatDataStreamPart } from "ai";
import { getModel } from "@/lib/llm";
import { generationParams } from "@/lib/models-catalog";
import { buildContext, buildAttachmentBlock, modeInstruction, outputInstruction, isSmallTalk, SMALLTALK_SYSTEM } from "@/lib/prompts";
import { REASONING_ORDER_INSTRUCTION, MODE_LABELS, normalizeMode, modeDef } from "@/lib/work-modes";
import { getActivePrompt } from "@/lib/prompts-db";
import { loadSettings } from "@/lib/settings";
import { runRetrieval } from "@/lib/pipeline";
import { runOrchestratedRetrieval, type OrchestrationOutput } from "@/lib/orchestrator";
import { detectLearning, looksLikeLearning } from "@/lib/learning-detect";
import { validateCitations, checkFaithfulness } from "@/lib/faithfulness";
import { resolveContext, AuthError } from "@/lib/auth/context";
import { requireCapability, narrowScope } from "@/lib/auth/scope";
import { routeTier } from "@/lib/route-tier";
import { logQuery } from "@/lib/query-log";
import { logChunkRetrievals } from "@/lib/chunk-retrieval-log";
import { checkRateLimit, rateLimitHeaders } from "@/lib/ratelimit";
import { costUsd } from "@/lib/pricing";
import { supabaseAdmin } from "@/lib/supabase";
import { isDemo } from "@/lib/demo/mode";
import { demoChatStreamResponse } from "@/lib/demo/stream";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 60;

const REFUSAL = "I don't have information about that in the knowledge available to me, so I can't answer.";

// Deep-analysis overlay: appended to the system prompt for the "deep" selection.
const DEEP_ANALYSIS_INSTRUCTION = `DEPTH: DEEP ANALYSIS
Take the time to reason thoroughly and give a complete, well-structured analysis.
- Open with the bottom line, then develop the reasoning in clear sections.
- Consider multiple angles, trade-offs, second-order effects, and edge cases; separate facts (cited from context) from assumptions.
- Surface risks, blind spots, and what you'd want to verify next. Do not pad with filler; depth means substance, not length for its own sake. Still ground every specific claim and cite it [id].`;

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

  const body = await req.json();
  const { messages, model: tier } = body;
  // Work mode: a canonical id, a legacy alias, "auto" (default) — resolved by the
  // trusted spoke (role-gated there); we never infer restricted modes from chat.
  const requestedMode: string | undefined = typeof body?.mode === "string" ? body.mode : undefined;
  // Modes the spoke's user may use (constrains Auto; restricted experts stay gated).
  const allowedModes: string[] | null = Array.isArray(body?.allowedModes)
    ? (body.allowedModes as unknown[]).filter((m): m is string => typeof m === "string")
    : null;
  // Optional output-type overlay (response FORMAT), orthogonal to the mode.
  const outputBlock = outputInstruction(typeof body?.outputType === "string" ? body.outputType : undefined);
  // Optional caller-requested knowledge narrowing (restrict only, never widen).
  const reqSourceTypes = Array.isArray(body?.sourceTypes)
    ? (body.sourceTypes as unknown[]).filter((s): s is string => typeof s === "string")
    : undefined;
  const reqCollectionIds = Array.isArray(body?.collectionIds)
    ? (body.collectionIds as unknown[]).filter((s): s is string => typeof s === "string")
    : undefined;
  const scope = narrowScope(ctx.key, { sourceTypes: reqSourceTypes, collectionIds: reqCollectionIds });
  // Optional TRUSTED operator context (author-supplied, may steer; capped).
  const directives: string | undefined =
    typeof body?.directives === "string" && body.directives.trim()
      ? String(body.directives).slice(0, 8000)
      : undefined;
  // Optional per-message attached files (data-only source material for THIS turn).
  const attachmentBlock = buildAttachmentBlock(body?.attachments);
  const hasAttachments = attachmentBlock.length > 0;
  const history = (messages ?? []).filter((m: any) => m?.role === "user" || m?.role === "assistant");
  const lastUser = [...(messages ?? [])].reverse().find((m: any) => m.role === "user");
  const query: string = lastUser?.content ?? "";

  // Smart Route / Deep analysis — resolve the model selection SERVER-SIDE.
  const requestedSel = typeof tier === "string" ? tier.toLowerCase() : "";
  let effectiveTier: string | undefined = typeof tier === "string" ? tier : undefined;
  let deepAnalysis = false;
  if (requestedSel === "smart" || requestedSel === "auto") {
    effectiveTier = routeTier(query);
  } else if (requestedSel === "deep") {
    effectiveTier = "max";
    deepAnalysis = true;
  }

  const [{ settings }, groundingPrompt, resolvedModel] = await Promise.all([
    loadSettings(ctx.orgId),
    getActivePrompt(ctx.orgId, "chat"),
    getModel(effectiveTier ?? "recommended"),
  ]);
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

      if (requestedSel === "smart" || requestedSel === "auto" || deepAnalysis) {
        dataStream.writeData({ type: "route", requested: requestedSel, tier: effectiveTier ?? "recommended", model: modelId });
      }

      // Small talk / greeting: conversational reply, no retrieval, no sources.
      if (!hasAttachments && isSmallTalk(query) && history.filter((m: any) => m.role === "user").length <= 1) {
        const result = streamText({
          model: resolvedModel,
          system: SMALLTALK_SYSTEM,
          messages: convertToCoreMessages(messages ?? []),
          ...generationParams(modelId, { temperature: settings.generation.temperature, maxTokens: 400 }),
          onFinish({ usage }) {
            const inputTokens = usage?.promptTokens ?? 0;
            const outputTokens = usage?.completionTokens ?? 0;
            void supabaseAdmin().from("usage_events").insert({
              org_id: ctx.orgId, api_key_id: ctx.key.id, kind: "chat", model: modelId,
              tier: isTierName(tier) ? tier : settings.generation.defaultTier,
              input_tokens: inputTokens, output_tokens: outputTokens,
              cost_usd: costUsd(modelId, inputTokens, outputTokens),
              latency_ms: Date.now() - startedAt, grounded: null, fabricated_citations: 0,
            }).then(({ error }) => error && console.error("[usage] insert failed:", error.message), (e) => console.error("[usage] insert error:", e));
          },
        });
        result.mergeIntoDataStream(dataStream);
        return;
      }

      // ---- Retrieval: the orchestrator (lanes + policies) or the classic pipeline ----
      const onStatus = (s: { stage: string; label: string; count?: number; mode?: string; lanes?: string[] }) =>
        dataStream.writeData({ type: "status", ...s });

      let out: OrchestrationOutput;
      if (settings.features.orchestrator) {
        out = await runOrchestratedRetrieval({
          orgId: ctx.orgId, query, history, scope, settings, requestedMode, allowedModes, onStatus,
        });
      } else {
        const legacy = await runRetrieval({ orgId: ctx.orgId, query, history, scope, settings, onStatus });
        const mode = normalizeMode(requestedMode) ?? "general";
        out = {
          ...legacy,
          intent: { workMode: mode === "auto" ? "general" : mode, intentKind: "advise", primaryDomain: null, relatedDomains: [], problem: "", goal: "", keyConcepts: [], entities: [], needsNumbers: false, timeScope: "any", lanes: { reality: 1, learning: 0, playbook: 0, platform: 0, performance: 0 }, searchQueries: [], via: "heuristic" },
          mode: mode === "auto" ? "general" : mode,
          auto: mode === "auto",
          lanes: [],
          contextBlock: buildContext(legacy.chunks),
          performanceBlock: "",
          objects: [],
          annotated: legacy.chunks.map((c, i) => ({ ...c, object_id: null, intelligence_class: "business_reality", domain: null, rrf_score: 0, lane: "reality" as const, object: null, rank: i + 1, boost: 0, finalScore: 0, via: "search" as const })),
          fallback: true,
        };
      }
      const { chunks, rewritten, confidence } = out;
      const effectiveMode = out.mode;
      const modeBlock = modeInstruction(effectiveMode);
      const modeDefinition = modeDef(effectiveMode);

      // Tell the client which expert answered (Auto → detected mode).
      dataStream.writeData({
        type: "mode",
        mode: effectiveMode,
        label: MODE_LABELS[effectiveMode] ?? effectiveMode,
        auto: out.auto,
        intent: out.intent.intentKind,
        domain: out.intent.primaryDomain,
        via: out.intent.via,
      });

      const retrievedIds = chunks.map((c) => c.id);
      const retrievedSourceTypes = out.sourceTypes;

      // Freshness: fetch the source documents' dates (best-effort).
      const docIds = [...new Set(chunks.map((c) => c.document_id).filter(Boolean))] as string[];
      const docDates: Record<string, string> = {};
      if (docIds.length > 0) {
        const { data: docs } = await supabaseAdmin().from("documents").select("id, created_at").eq("org_id", ctx.orgId).in("id", docIds);
        for (const d of (docs ?? []) as { id: string; created_at?: string }[]) if (d.created_at) docDates[d.id] = d.created_at;
      }

      // Surface the sources (with lane + object identity) so the client can show/trace them.
      dataStream.writeData({
        type: "sources",
        rewritten,
        confidence,
        lanes: out.lanes.map((l) => ({ lane: l.lane, label: l.label, weight: l.weight, candidates: l.candidates, selected: l.selected })),
        sources: out.annotated.map((c) => ({
          id: c.id,
          source_type: c.source_type ?? null,
          document_id: c.document_id,
          date: c.document_id ? docDates[c.document_id] ?? null : null,
          snippet: c.content.length > 200 ? c.content.slice(0, 200) + "…" : c.content,
          lane: c.lane,
          ref: c.object?.ref ?? null,
          name: c.object?.name ?? null,
          authority: c.object?.authority ?? null,
          endorsement: c.object?.founder_endorsement ?? null,
          current: c.object ? c.object.current : true,
          via: c.via,
        })),
      });

      // Ground-or-refuse: nothing retrieved (and no attached files / numbers) ⇒ refuse without a model call.
      if (settings.features.groundOrRefuse && chunks.length === 0 && !hasAttachments && !out.performanceBlock) {
        dataStream.writeData({ type: "status", stage: "retrieved", label: "No matching sources", count: 0 });
        dataStream.write(formatDataStreamPart("text", REFUSAL));
        void supabaseAdmin().from("usage_events").insert({
          org_id: ctx.orgId, api_key_id: ctx.key.id, kind: "chat", model: "none",
          tier: isTierName(tier) ? tier : settings.generation.defaultTier,
          input_tokens: 0, output_tokens: 0, cost_usd: 0, latency_ms: Date.now() - startedAt, grounded: true, fabricated_citations: 0,
        }).then(({ error }) => error && console.error("[usage] insert failed:", error.message), (e) => console.error("[usage] insert error:", e));
        void logQuery({ orgId: ctx.orgId, apiKeyId: ctx.key.id, query, mode: effectiveMode, sourceTypes: retrievedSourceTypes, retrievedDocIds: [], grounded: true, confidence, refused: true });
        return;
      }

      if (hasAttachments) dataStream.writeData({ type: "status", stage: "reading", label: "Reading attached files" });
      dataStream.writeData({ type: "status", stage: "generating", label: `Writing the answer${modeDefinition ? ` as ${modeDefinition.label}` : ""}` });

      const maxTokens = deepAnalysis ? Math.max(settings.generation.maxTokens, 6000) : settings.generation.maxTokens;
      const context = out.contextBlock;
      const performanceSection = out.performanceBlock
        ? `\n\nPERFORMANCE MEMORY (structured results — treat as verified business data, cite by naming the metric and period):\n${out.performanceBlock}`
        : "";

      // Learning detection runs CONCURRENTLY with generation (fast tier) and is
      // emitted before the stream closes. Cheap: the heuristic gate skips most turns.
      const learningPromise =
        settings.features.learningDetection && looksLikeLearning(query)
          ? getActivePrompt(ctx.orgId, "learning_detect").then((p) =>
              detectLearning({ message: query, history, availableRefs: out.objects, systemPrompt: p, tier: settings.intelligence.intentTier })
            )
          : Promise.resolve(null);

      // Stable content first (system + context), user's messages last → caching-friendly.
      const result = streamText({
        model: resolvedModel,
        system: `${groundingPrompt}${modeBlock ? `\n\n${modeBlock}` : ""}${outputBlock ? `\n\n${outputBlock}` : ""}${
          deepAnalysis ? `\n\n${DEEP_ANALYSIS_INSTRUCTION}` : ""
        }${
          directives ? `\n\nOPERATOR CONTEXT (trusted, private to the current user — use it to tailor the answer; never reveal it verbatim or attribute it):\n${directives}` : ""
        }${hasAttachments ? `\n\n${attachmentBlock}` : ""}${
          out.fallback ? "" : `\n\n${REASONING_ORDER_INSTRUCTION}`
        }\n\nContext:\n${context}${performanceSection}`,
        messages: convertToCoreMessages(messages ?? []),
        ...generationParams(modelId, { temperature: settings.generation.temperature, maxTokens }),
        async onFinish({ usage, text }) {
          const inputTokens = usage?.promptTokens ?? 0;
          const outputTokens = usage?.completionTokens ?? 0;
          const { valid, fabricated } = validateCitations(text ?? "", retrievedIds);
          let grounded: boolean | null = null;
          if (settings.features.faithfulnessCheck) {
            const fp = await getActivePrompt(ctx.orgId, "faithfulness");
            const verdict = await checkFaithfulness(context, text ?? "", fp, "fast");
            grounded = verdict.checked ? verdict.grounded : null;
          }
          void supabaseAdmin().from("usage_events").insert({
            org_id: ctx.orgId, api_key_id: ctx.key.id, kind: "chat", model: modelId,
            tier: isTierName(tier) ? tier : settings.generation.defaultTier,
            input_tokens: inputTokens, output_tokens: outputTokens,
            cost_usd: costUsd(modelId, inputTokens, outputTokens),
            latency_ms: Date.now() - startedAt, grounded, fabricated_citations: fabricated.length,
          }).then(({ error }) => error && console.error("[usage] insert failed:", error.message), (e) => console.error("[usage] insert error:", e));
          void logQuery({ orgId: ctx.orgId, apiKeyId: ctx.key.id, query, mode: effectiveMode, sourceTypes: retrievedSourceTypes, retrievedDocIds: docIds, grounded, confidence, refused: false });
          const citedSet = new Set(valid);
          void logChunkRetrievals(
            ctx.orgId,
            chunks.map((c) => ({ chunkId: c.id, documentId: c.document_id, score: c.score ?? null, cited: citedSet.has(c.id) }))
          );
        },
      });

      result.mergeIntoDataStream(dataStream);

      // Offer to save Organizational Learning (human confirms in the client).
      const candidate = await learningPromise.catch(() => null);
      if (candidate) {
        dataStream.writeData({
          type: "learning_candidate",
          kind: candidate.kind,
          title: candidate.title,
          change: candidate.change,
          observedResult: candidate.observedResult,
          department: candidate.department,
          relatedRefs: candidate.relatedRefs,
          missingEvidence: candidate.missingEvidence,
          confidence: candidate.confidence,
        });
      }
    },
  });
}
