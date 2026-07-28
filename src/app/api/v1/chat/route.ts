// POST /api/v1/chat — grounded, cited, streamed chat over the key's permitted data.
//
// Auth:  Authorization: Bearer psk_...
// Scope: enforced by the key (capability 'chat' + source_types/data_sources/collections).
// Body:  { messages: [{role, content}], model?: "fast"|"recommended"|"max"|"<id>" }

import { streamText, convertToCoreMessages } from "ai";
import { modelForTier } from "@/lib/llm";
import { hybridSearchScoped, expandParents } from "@/lib/retrieval";
import { rerank } from "@/lib/rerank";
import { GROUNDED_SYSTEM, buildContext } from "@/lib/prompts";
import { resolveContext, AuthError } from "@/lib/auth/context";
import { requireCapability, scopeFilters } from "@/lib/auth/scope";
import { isDemo } from "@/lib/demo/mode";
import { demoChatStreamResponse } from "@/lib/demo/stream";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 60;

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
  const candidates = await hybridSearchScoped({
    orgId: ctx.orgId,
    query,
    scope: scopeFilters(ctx.key),
    matchCount: 40,
  });
  const top = await rerank(query, candidates, 8);
  const context = buildContext(await expandParents(top));

  // Stable content first (system + context), user's messages last -> caching-friendly.
  const result = streamText({
    model: modelForTier(tier),
    system: `${GROUNDED_SYSTEM}\n\nContext:\n${context}`,
    messages: convertToCoreMessages(messages ?? []),
  });
  return result.toDataStreamResponse();
}
