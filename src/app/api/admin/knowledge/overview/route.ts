// GET /api/admin/knowledge/overview — the CEO "AI Brain overview": live numbers
// for every component of the Operating Intelligence System in one org-scoped
// read. Parts that are unavailable (pre-migration) come back null, never 5xx.

import { supabaseAdmin } from "@/lib/supabase";
import { getBrainOverview } from "@/lib/brain-overview";
import { guard } from "../_shared";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
// ~30 parallel count queries; give a cold function room without hanging forever.
export const maxDuration = 60;

export async function GET() {
  const g = await guard();
  if ("response" in g) return g.response;
  const { admin } = g;
  try {
    const overview = await getBrainOverview(supabaseAdmin(), admin.orgId);
    return Response.json(overview, { headers: { "Cache-Control": "private, max-age=30" } });
  } catch (e) {
    console.error("[overview] failed:", e instanceof Error ? e.message : e);
    return Response.json({ error: "The overview could not be computed right now." }, { status: 500 });
  }
}
