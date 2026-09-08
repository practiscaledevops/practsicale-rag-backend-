// /api/admin/playground — internal test chat for admins.
//
// The dashboard's grounded playground. Unlike the public /api/v1/chat (scoped by
// a psk_ key), this authenticates with the ADMIN SESSION and searches the FULL
// org — no scope restriction — so an admin can probe everything the Brain knows.
// It runs the SAME settings-driven pipeline and DB-editable prompts as the public
// API, so what an admin tests here is what consumers get.
//
// SECURITY: org_id is resolved SERVER-SIDE from the admin session (never from the
// request body). Retrieved content is passed to the model as data, never as
// instructions (see the grounding prompt).
//
//   GET   -> { sourceTypes: string[] }  distinct source types present in the org
//   POST  -> NDJSON stream:
//              {"type":"citations","citations":[...]}
//              {"type":"text","value":"..."}            (repeated)
//              {"type":"grounding","grounded":bool,"unsupported":[...],"fabricated":[...]}
//              {"type":"error","message":"..."}         (only on failure)

import { streamText, convertToCoreMessages } from "ai";
import { getModel } from "@/lib/llm";
import { buildContext } from "@/lib/prompts";
import { getActivePrompt } from "@/lib/prompts-db";
import { loadSettings } from "@/lib/settings";
import { runRetrieval } from "@/lib/pipeline";
import { validateCitations, checkFaithfulness } from "@/lib/faithfulness";
import { costUsd } from "@/lib/pricing";
import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
import { isDemo } from "@/lib/demo/mode";
import { demoAnswerText } from "@/lib/demo/stream";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 60;

function isTierName(v: unknown): v is "fast" | "recommended" | "max" {
  return v === "fast" || v === "recommended" || v === "max";
}

/** GET: distinct source types in the org, to populate the filter dropdown. */
export async function GET() {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("documents")
    .select("source_type")
    .eq("org_id", admin.orgId);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const set = new Set<string>();
  for (const d of data ?? []) if (d.source_type) set.add(d.source_type as string);
  return Response.json({ sourceTypes: [...set].sort() });
}

export async function POST(req: Request) {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  const body = await req.json().catch(() => ({}));
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tier: string | undefined = body?.model;
  const sourceType: string | undefined =
    typeof body?.sourceType === "string" && body.sourceType ? body.sourceType : undefined;

  const history = messages.filter(
    (m: { role?: string }) => m.role === "user" || m.role === "assistant"
  );
  const lastUser = [...messages].reverse().find((m: { role?: string }) => m.role === "user");
  const query: string = lastUser?.content ?? "";

  const [{ settings }, groundingPrompt] = await Promise.all([
    loadSettings(admin.orgId),
    getActivePrompt(admin.orgId, "chat"),
  ]);

  // Full-org retrieval (no key scope). The optional source_type narrows testing.
  const { chunks } = await runRetrieval({
    orgId: admin.orgId,
    query,
    history,
    scope: {
      sourceTypes: sourceType ? [sourceType] : [],
      dataSourceIds: [],
      collectionIds: [],
    },
    settings,
  });

  const retrievedIds = chunks.map((c) => c.id);
  const context = buildContext(chunks);
  const citations = chunks.map((c) => ({
    id: c.id,
    document_id: c.document_id,
    source_type: c.source_type ?? null,
    snippet: c.content.length > 240 ? c.content.slice(0, 240) + "…" : c.content,
  }));

  const encoder = new TextEncoder();
  const line = (obj: unknown) => encoder.encode(JSON.stringify(obj) + "\n");

  // DEMO MODE: real retrieval (fake store), canned answer, same NDJSON protocol.
  if (isDemo()) {
    const answer = demoAnswerText(query);
    const parts = answer.match(/\S+\s*/g) ?? [answer];
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(line({ type: "citations", citations }));
        for (const p of parts) {
          controller.enqueue(line({ type: "text", value: p }));
          await new Promise((r) => setTimeout(r, 22));
        }
        controller.enqueue(line({ type: "grounding", grounded: true, unsupported: [], fabricated: [] }));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
    });
  }

  // Ground-or-refuse guard: nothing retrieved ⇒ refuse without a model call.
  if (settings.features.groundOrRefuse && chunks.length === 0) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(line({ type: "citations", citations: [] }));
        controller.enqueue(
          line({ type: "text", value: "I don't have information about that in this org's data, so I can't answer." })
        );
        controller.enqueue(line({ type: "grounding", grounded: true, unsupported: [], fabricated: [] }));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const resolvedModel = await getModel(tier ?? settings.generation.defaultTier);
  const modelId = resolvedModel.modelId;
  const startedAt = Date.now();

  const result = streamText({
    model: resolvedModel,
    system: `${groundingPrompt}\n\nContext:\n${context}`,
    messages: convertToCoreMessages(messages),
    temperature: settings.generation.temperature,
    maxTokens: settings.generation.maxTokens,
    onFinish({ usage }) {
      const inputTokens = usage?.promptTokens ?? 0;
      const outputTokens = usage?.completionTokens ?? 0;
      void supabaseAdmin()
        .from("usage_events")
        .insert({
          org_id: admin.orgId,
          user_id: admin.userId,
          api_key_id: null,
          kind: "chat",
          model: modelId,
          tier: isTierName(tier) ? tier : settings.generation.defaultTier,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cost_usd: costUsd(modelId, inputTokens, outputTokens),
          latency_ms: Date.now() - startedAt,
        });
    },
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(line({ type: "citations", citations }));
      let answer = "";
      try {
        for await (const delta of result.textStream) {
          answer += delta;
          controller.enqueue(line({ type: "text", value: delta }));
        }
        // Anti-hallucination verdict after the answer completes.
        const { fabricated } = validateCitations(answer, retrievedIds);
        let grounded = true;
        let unsupported: string[] = [];
        if (settings.features.faithfulnessCheck) {
          const fp = await getActivePrompt(admin.orgId, "faithfulness");
          const verdict = await checkFaithfulness(context, answer, fp, "fast");
          grounded = verdict.grounded;
          unsupported = verdict.unsupported;
        }
        controller.enqueue(line({ type: "grounding", grounded, unsupported, fabricated }));
      } catch {
        controller.enqueue(line({ type: "error", message: "Generation failed." }));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
