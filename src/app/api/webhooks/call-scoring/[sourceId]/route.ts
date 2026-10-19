import { createHmac, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { drainScoringEvents } from "@/lib/connectors/scoring-events";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 300;
const Event = z.object({ event_id: z.string().uuid(), report_id: z.string().uuid(), updated_at: z.string().datetime({ offset: true }) }).strict();

export async function POST(req: Request, { params }: { params: Promise<{ sourceId: string }> }) {
  const secret = process.env.SCORING_WEBHOOK_SECRET;
  if (!secret || secret.length < 32) return Response.json({ error: "Scoring webhook is not configured" }, { status: 503 });
  const timestamp = req.headers.get("x-brain-timestamp") ?? "";
  const signature = req.headers.get("x-brain-signature") ?? "";
  if (!/^\d{10}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !/^v1=[a-f0-9]{64}$/.test(signature))
    return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
  let raw = "";
  const reader = req.body?.getReader();
  if (!reader) return Response.json({ error: "Missing body" }, { status: 400 });
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    if (raw.length > 4096) { await reader.cancel(); return Response.json({ error: "Body too large" }, { status: 413 }); }
  }
  raw += decoder.decode();
  const expected = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  if (!timingSafeEqual(Buffer.from(signature.slice(3)), Buffer.from(expected))) return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = Event.safeParse(body);
  const { sourceId } = await params;
  if (!parsed.success || !z.string().uuid().safeParse(sourceId).success) return Response.json({ error: "Invalid event" }, { status: 400 });
  const db = supabaseAdmin();
  const { data: source, error } = await db.from("data_sources").select("id,org_id").eq("id", sourceId).eq("source_type", "call_score").eq("is_active", true).maybeSingle();
  if (error || !source) return Response.json({ error: "Unknown scoring source" }, { status: 404 });
  // Org comes only from the registered source. The signed body carries IDs,
  // never an org or a snapshot that could overwrite newer source truth.
  const { error: insertError } = await db.from("scoring_sync_events").insert({ id: parsed.data.event_id, org_id: source.org_id, data_source_id: source.id, record_id: parsed.data.report_id });
  if (insertError && insertError.code !== "23505") return Response.json({ error: "Could not durably accept event; retry" }, { status: 503 });
  if (insertError) {
    const { data: seen } = await db.from("scoring_sync_events").select("data_source_id,record_id,status").eq("id", parsed.data.event_id).eq("org_id", source.org_id).maybeSingle();
    if (!seen || seen.data_source_id !== sourceId || seen.record_id !== parsed.data.report_id) return Response.json({ error: "Event id conflict" }, { status: 409 });
  }
  after(() => drainScoringEvents().catch(() => console.error("[scoring-sync] background drain failed; cron will retry")));
  return Response.json({ accepted: true, event_id: parsed.data.event_id }, { status: 202 });
}
