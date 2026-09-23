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
//   • a conflicts event 2:[{type:"conflicts",pairs:[{a:{ref,name,authority},b:{ref,name,authority},note}]}]
//                                                                       (sources in context that contradict each other; only when any)
//   • a performance event 2:[{type:"performance",metrics:[{key,label,value,unit,period_start,period_end,dimensions,source}]}]
//                                                                       (the Performance Memory rows the answer reasons from; only when any)
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
import { waitUntil } from "@vercel/functions";
import { z } from "zod";
import { getModel } from "@/lib/llm";
import { generationParams, MODELS } from "@/lib/models-catalog";
import { buildContext, buildAttachmentBlock, modeInstruction, outputInstruction, isSmallTalk, SMALLTALK_SYSTEM } from "@/lib/prompts";
import { REASONING_ORDER_INSTRUCTION, MODE_LABELS, normalizeMode, modeDef } from "@/lib/work-modes";
import { getActivePrompt } from "@/lib/prompts-db";
import { loadSettings } from "@/lib/settings";
import { runRetrieval } from "@/lib/pipeline";
import { runOrchestratedRetrieval, type OrchestrationOutput } from "@/lib/orchestrator";
import { metricEventRows } from "@/lib/performance-memory";
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
// Long BUILD/deep answers (a full training program, a decision memo) plus the
// orchestrator's pre-generation work can exceed 60s; a function timeout cuts the
// stream mid-answer (no finish part). 300s is the Vercel Pro ceiling. The spoke's
// /api/chat must match or it would sever a still-streaming answer at its own wall.
export const maxDuration = 300;

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

  // The wall clock starts here: the generation deadline is measured against
  // Vercel's function timeout, which has been running since the request began.
  const startedAt = Date.now();

  // Validate the body up front: bounded messages/strings/arrays, 400 on
  // anything malformed (a bad payload used to surface as a 500 mid-pipeline).
  const parsedBody = ChatBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsedBody.success) {
    return Response.json(
      { error: `Invalid request body: ${parsedBody.error.issues[0]?.path.join(".") || "body"} ${parsedBody.error.issues[0]?.message ?? ""}`.trim() },
      { status: 400 }
    );
  }
  const body = parsedBody.data;
  // Only user/assistant turns reach the model; a caller-supplied "system" turn
  // would otherwise ride along as extra instructions.
  const messages = body.messages.filter((m) => m.role !== "system");
  // Per-field caps still allow a ~2.7M-char prompt (60 × 40k + attachments);
  // the per-key limit counts requests, not tokens, so cap the whole turn too.
  const totalChars =
    messages.reduce((n, m) => n + m.content.length, 0) +
    (body.attachments ?? []).reduce((n, a) => n + a.text.length, 0) +
    (body.directives?.length ?? 0);
  if (totalChars > MAX_TURN_CHARS) {
    return Response.json({ error: `Request too large: ${totalChars} characters across messages and attachments (limit ${MAX_TURN_CHARS}). Start a new conversation or attach less.` }, { status: 413 });
  }
  const tier = body.model;
  // Model selection must be a tier alias, a routing keyword, or a catalogued id —
  // an arbitrary id is uncapped cost (or a mid-stream 400 from the provider).
  if (typeof tier === "string" && !isAllowedModelSelection(tier)) {
    return Response.json({ error: `Unknown model selection '${tier.slice(0, 40)}'` }, { status: 400 });
  }
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

  return createDataStreamResponse({
    headers: { "x-model": modelId, "x-provider": provider, ...rateLimitHeaders(rl) },
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
          performanceMetrics: [],
          conflicts: [],
          objects: [],
          annotated: legacy.chunks.map((c, i) => ({ ...c, object_id: null, intelligence_class: "business_reality", domain: null, rrf_score: 0, lane: "reality" as const, object: null, rank: i + 1, boost: 0, finalScore: 0, via: "search" as const })),
          fallback: true,
          callReview: undefined,
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

      // Exhaustive call-review set: when the structured path pulled EVERY call
      // matching a named date/consultant/practice, tell the client so it can show
      // "Reviewing all N calls from …" (and any "narrow it down" note).
      if (out.callReview) {
        const f = out.callReview.filter;
        dataStream.writeData({
          type: "call_review",
          count: out.callReview.count,
          note: out.callReview.note,
          filter: { date: f.date ?? null, consultants: f.consultants ?? null, practiceType: f.practiceType ?? null },
        });
      }

      // Disagreements among the retrieved sources, and the structured numbers the
      // answer reasons from — so the client can show both, not only the prose.
      if (out.conflicts.length) dataStream.writeData({ type: "conflicts", pairs: out.conflicts });
      if (out.performanceMetrics.length) dataStream.writeData({ type: "performance", metrics: metricEventRows(out.performanceMetrics) });

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

      // BUILD-intent answers (a full training, an SOP, a complete system) and
      // deep analysis need room; a normal cap truncates them mid-way.
      const wantsLong = deepAnalysis || out.intent.intentKind === "build";
      const maxTokens = wantsLong ? Math.max(settings.generation.maxTokens, 8000) : settings.generation.maxTokens;
      const context = out.contextBlock;
      const performanceSection = out.performanceBlock
        ? `\n\nPERFORMANCE MEMORY (structured results — treat as verified business data, cite by naming the metric and period):\n${out.performanceBlock}`
        : "";

      // Learning detection runs CONCURRENTLY with generation (fast tier) and is
      // emitted before the stream closes. Cheap: the heuristic gate skips most turns.
      const learningPromise =
        settings.features.learningDetection && looksLikeLearning(query)
          ? getActivePrompt(ctx.orgId, "learning_detect")
              .then((p) =>
                detectLearning({ message: query, history, availableRefs: out.objects, systemPrompt: p, tier: settings.intelligence.intentTier })
              )
              // Never an unhandled rejection: if generation throws first, this
              // promise is only awaited later (or not at all).
              .catch(() => null)
          : Promise.resolve(null);

      // Stable content first (system + context), user's messages last → caching-friendly.
      const system = `${groundingPrompt}${modeBlock ? `\n\n${modeBlock}` : ""}${outputBlock ? `\n\n${outputBlock}` : ""}${
        deepAnalysis ? `\n\n${DEEP_ANALYSIS_INSTRUCTION}` : ""
      }${
        directives ? `\n\nOPERATOR CONTEXT (trusted, private to the current user — use it to tailor the answer; never reveal it verbatim or attribute it):\n${directives}` : ""
      }${hasAttachments ? `\n\n${attachmentBlock}` : ""}${
        out.fallback ? "" : `\n\n${REASONING_ORDER_INSTRUCTION}`
      }\n\nContext:\n${context}${performanceSection}`;
      const baseMessages = convertToCoreMessages(messages ?? []);

      // Generate with automatic continuation. A single model call stops at its
      // output cap (finishReason "length"); rather than delivering a clipped
      // answer, we ask the model to resume exactly where it stopped and stream
      // the remainder into the SAME message, while the function's wall clock
      // allows. Each step is budgeted from the observed tokens/s so it finishes
      // before the deadline; if the answer still cannot complete, it ends with a
      // visible "send continue" note instead of a silent cut.
      const maxSteps = wantsLong ? 4 : 2;
      const deadline = startedAt + GENERATION_DEADLINE_MS;
      let fullText = "";
      let promptTokens = 0;
      let completionTokens = 0;
      let finishReason: "stop" | "length" = "stop";
      let tokensPerSec = 0;
      let clipped = false;

      for (let step = 0; step < maxSteps; step++) {
        // Fit each step into the time left (keep a margin to close the stream).
        // The first step has no observed rate yet, so it assumes a conservative
        // one — a long orchestration must not leave step 0 a budget the wall
        // clock can't honour (that is the silent cut this loop exists to prevent).
        const rate = step === 0 ? ASSUMED_TOKENS_PER_SEC : tokensPerSec;
        const affordable = Math.floor(((deadline - Date.now() - 15_000) / 1000) * rate);
        const stepTokens = Math.min(maxTokens, Math.max(step === 0 ? MIN_CONTINUATION_TOKENS : 0, affordable));
        if (step > 0 && stepTokens < MIN_CONTINUATION_TOKENS) {
          clipped = true;
          break;
        }
        const stepMessages =
          step === 0
            ? baseMessages
            : [
                ...baseMessages,
                { role: "assistant" as const, content: fullText },
                { role: "user" as const, content: continueInstruction(fullText) },
              ];
        const stepStarted = Date.now();
        const result = streamText({
          model: resolvedModel,
          system,
          messages: stepMessages,
          ...generationParams(modelId, { temperature: settings.generation.temperature, maxTokens: stepTokens }),
        });
        // Write text parts ourselves (not mergeIntoDataStream) so steps append to
        // one message in strict order and we control the single finish part.
        // The trailing partial word is held back until the step's finish reason
        // is known: a "length" cut then ends on a clean word boundary (trailing
        // whitespace kept), so the continuation — whose leading whitespace the
        // provider strips — joins as "He missed", never "Hemissed".
        let pending = "";
        const flush = (upTo: number) => {
          const chunk = pending.slice(0, upTo);
          if (!chunk) return;
          dataStream.write(formatDataStreamPart("text", chunk));
          fullText += chunk;
          pending = pending.slice(upTo);
        };
        for await (const delta of result.textStream) {
          pending += delta;
          const ws = lastWhitespace(pending);
          if (ws >= 0) flush(ws + 1);
          else if (pending.length > HOLDBACK_MAX_CHARS) flush(pending.length);
        }
        const [reason, usage] = await Promise.all([result.finishReason, result.usage]);
        // Completed (or too long to be a word): send the held-back tail. On a
        // length cut the partial word is dropped and regenerated by the next step.
        if (reason !== "length" || pending.length > HOLDBACK_MAX_CHARS) flush(pending.length);
        pending = "";
        promptTokens += usage?.promptTokens ?? 0;
        completionTokens += usage?.completionTokens ?? 0;
        tokensPerSec = (usage?.completionTokens ?? 0) / Math.max(1, (Date.now() - stepStarted) / 1000);
        finishReason = reason === "length" ? "length" : "stop";
        if (reason !== "length") break;
        if (step === maxSteps - 1) clipped = true;
      }

      if (clipped) {
        dataStream.write(formatDataStreamPart("text", CLIPPED_NOTE));
        fullText += CLIPPED_NOTE;
      }
      dataStream.write(
        formatDataStreamPart("finish_message", { finishReason, usage: { promptTokens, completionTokens } })
      );

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

      // Post-answer bookkeeping over the COMPLETE text: citations, faithfulness,
      // metering, logs. Vercel freezes the instance once the response is done,
      // so this work is registered with waitUntil (kept alive after the stream
      // closes) instead of being left as fire-and-forget promises.
      const { valid, fabricated } = validateCitations(fullText, retrievedIds);
      const citedSet = new Set(valid);
      const latencyMs = Date.now() - startedAt;
      waitUntil(
        (async () => {
          let grounded: boolean | null = null;
          // The faithfulness judge is an LLM call; skip it when the wall clock is
          // nearly spent rather than lose the metering row with it.
          if (settings.features.faithfulnessCheck && Date.now() < deadline - 30_000) {
            try {
              const fp = await getActivePrompt(ctx.orgId, "faithfulness");
              // Judge against everything the model was given, numbers included.
              const verdict = await checkFaithfulness(`${context}${performanceSection}`, fullText, fp, "fast");
              grounded = verdict.checked ? verdict.grounded : null;
            } catch (e) {
              console.error("[faithfulness] check failed:", e instanceof Error ? e.message : e);
            }
          }
          await Promise.allSettled([
            supabaseAdmin().from("usage_events").insert({
              org_id: ctx.orgId, api_key_id: ctx.key.id, kind: "chat", model: modelId,
              tier: isTierName(tier) ? tier : settings.generation.defaultTier,
              input_tokens: promptTokens, output_tokens: completionTokens,
              cost_usd: costUsd(modelId, promptTokens, completionTokens),
              latency_ms: latencyMs, grounded, fabricated_citations: fabricated.length,
            }).then(({ error }) => error && console.error("[usage] insert failed:", error.message), (e) => console.error("[usage] insert error:", e)),
            logQuery({ orgId: ctx.orgId, apiKeyId: ctx.key.id, query, mode: effectiveMode, sourceTypes: retrievedSourceTypes, retrievedDocIds: docIds, grounded, confidence, refused: false }),
            logChunkRetrievals(
              ctx.orgId,
              chunks.map((c) => ({ chunkId: c.id, documentId: c.document_id, score: c.score ?? null, cited: citedSet.has(c.id) }))
            ),
          ]);
        })()
      );
    },
  });
}

// A whole turn (messages + attachments + directives) may not exceed this many
// characters — roughly 30k tokens of prompt, which every catalogued model accepts.
const MAX_TURN_CHARS = 120_000;

// Generation must finish (stream closed, finish part written) before Vercel's
// 300s wall; the pre-generation work (classify → search → rerank) is already
// counted against it, so the loop budgets from `startedAt`.
const GENERATION_DEADLINE_MS = 275_000;
// Below this a continuation step cannot add a meaningful section; stop instead.
const MIN_CONTINUATION_TOKENS = 600;
// Output speed assumed for the first step before any rate is observed (the
// slowest catalogued model streams ~35-70 tok/s); later steps use the real rate.
const ASSUMED_TOKENS_PER_SEC = 35;

// Request body contract (see the header comment). Bounded everywhere so a bad
// or hostile payload is a 400, never a 500 mid-pipeline or an unbounded prompt.
const ChatBodySchema = z
  .object({
    messages: z
      .array(z.object({ role: z.enum(["user", "assistant", "system"]), content: z.string().max(40_000) }))
      .min(1)
      .max(60),
    model: z.string().max(64).optional(),
    mode: z.string().max(64).optional(),
    allowedModes: z.array(z.string().max(64)).max(40).optional(),
    outputType: z.string().max(40).optional(),
    sourceTypes: z.array(z.string().max(64)).max(50).optional(),
    collectionIds: z.array(z.string().max(64)).max(50).optional(),
    directives: z.string().max(8000).optional(),
    attachments: z.array(z.object({ name: z.string().max(200), text: z.string().max(60_000) })).max(5).optional(),
  })
  .passthrough();

const SELECTION_KEYWORDS = new Set(["fast", "recommended", "max", "smart", "auto", "deep"]);
/** A tier alias, a routing keyword, or an id from the model catalogue. */
function isAllowedModelSelection(v: string): boolean {
  const s = v.trim().toLowerCase();
  return SELECTION_KEYWORDS.has(s) || MODELS.some((m) => m.id === s);
}
// A "partial word" held back longer than this (a URL, a code token) is flushed as-is.
const HOLDBACK_MAX_CHARS = 200;

/** Index of the last whitespace character in `s`, or -1. */
function lastWhitespace(s: string): number {
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 10 || c === 9 || c === 13) return i;
  }
  return -1;
}

const CLIPPED_NOTE =
  "\n\n---\n*This reply reached the length limit for one turn. Send **continue** and I'll pick up exactly where it stopped.*";

/** The continuation turn: resume the clipped answer seamlessly, no restart or recap. */
function continueInstruction(soFar: string): string {
  const tail = soFar.slice(-400);
  return (
    "Your previous message was cut off by the output length limit. Continue it now from exactly where it stopped. " +
    "Output ONLY the remaining content: do not repeat anything already written, do not restart, recap, apologize, or add a preamble. " +
    "If it stopped mid-sentence, mid-list, or mid-table row, resume mid-sentence / mid-row so the two parts join seamlessly; " +
    "the text so far ends on a word boundary, so begin with the next word. " +
    "Keep the same structure, heading numbering, formatting, and citation style, and finish the complete deliverable.\n\n" +
    `The last characters already written were:\n«${tail}»`
  );
}
