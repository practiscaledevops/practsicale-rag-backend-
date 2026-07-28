// /api/admin/playground — internal test chat for admins.
//
// This is the dashboard's grounded playground. Unlike the public /api/v1/chat
// (which is authenticated by a scoped psk_ key and restricted to that key's
// data), this route authenticates with the ADMIN SESSION and searches the FULL
// org — no scope restriction — so an admin can probe everything the Brain knows.
// An optional source_type filter narrows retrieval for testing.
//
// SECURITY: org_id is resolved SERVER-SIDE from the admin session (never from the
// request body). Retrieved content is passed to the model as data, never as
// instructions (see GROUNDED_SYSTEM).
//
//   GET   -> { sourceTypes: string[] }  distinct source types present in the org
//   POST  -> NDJSON stream. First line is the citations payload, then one line
//            per text delta:
//              {"type":"citations","citations":[...]}
//              {"type":"text","value":"..."}
//            (a trailing {"type":"error"} line is emitted if generation fails)

import { streamText, convertToCoreMessages } from "ai";
import { modelForTier } from "@/lib/llm";
import { hybridSearchScoped, expandParents } from "@/lib/retrieval";
import { rerank } from "@/lib/rerank";
import { GROUNDED_SYSTEM, buildContext } from "@/lib/prompts";
import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 60;

// Rough per-1M-token pricing (USD) for metering playground traffic so Analytics
// reflects it. Estimates only — the source of truth for billing is the provider.
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-haiku": { in: 1, out: 5 },
  "claude-sonnet": { in: 3, out: 15 },
  "claude-opus": { in: 15, out: 75 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4o": { in: 2.5, out: 10 },
};

function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const match = Object.keys(PRICING).find((k) => model.startsWith(k));
  const p = match ? PRICING[match] : { in: 3, out: 15 }; // default ~= Sonnet
  return (inputTokens / 1e6) * p.in + (outputTokens / 1e6) * p.out;
}

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

  const lastUser = [...messages].reverse().find((m: { role?: string }) => m.role === "user");
  const query: string = lastUser?.content ?? "";

  // Full-org retrieval (no key scope). An empty array on a dimension means "no
  // restriction" (matches hybrid_search_scoped); the optional source_type narrows.
  const candidates = await hybridSearchScoped({
    orgId: admin.orgId,
    query,
    scope: {
      sourceTypes: sourceType ? [sourceType] : [],
      dataSourceIds: [],
      collectionIds: [],
    },
    matchCount: 40,
  });
  const top = await rerank(query, candidates, 8);
  const expanded = await expandParents(top);
  const context = buildContext(expanded);

  const citations = expanded.map((c) => ({
    id: c.id,
    document_id: c.document_id,
    source_type: c.source_type ?? null,
    snippet: c.content.length > 240 ? c.content.slice(0, 240) + "…" : c.content,
  }));

  const resolvedModel = modelForTier(tier);
  const modelId = resolvedModel.modelId;
  const startedAt = Date.now();

  // Stable content first (system + context), user's messages last -> caching-friendly.
  const result = streamText({
    model: resolvedModel,
    system: `${GROUNDED_SYSTEM}\n\nContext:\n${context}`,
    messages: convertToCoreMessages(messages),
    onFinish({ usage }) {
      // Fire-and-forget metering so playground traffic shows in Analytics too.
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
          tier: isTierName(tier) ? tier : "recommended",
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cost_usd: estimateCostUsd(modelId, inputTokens, outputTokens),
          latency_ms: Date.now() - startedAt,
        });
    },
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Citations first so the UI can render sources before the answer streams.
      controller.enqueue(encoder.encode(JSON.stringify({ type: "citations", citations }) + "\n"));
      try {
        for await (const delta of result.textStream) {
          controller.enqueue(encoder.encode(JSON.stringify({ type: "text", value: delta }) + "\n"));
        }
      } catch {
        controller.enqueue(
          encoder.encode(JSON.stringify({ type: "error", message: "Generation failed." }) + "\n")
        );
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
