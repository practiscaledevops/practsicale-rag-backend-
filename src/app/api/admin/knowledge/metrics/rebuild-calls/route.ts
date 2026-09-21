// POST /api/admin/knowledge/metrics/rebuild-calls — rebuild Performance Memory
// (consultant entities + company/consultant/segment metrics + the "Sales Call
// Performance — Team Snapshot" knowledge object) from the call-scoring data.
// Idempotent. org resolved server-side; needs documents:write.

import { supabaseAdmin } from "@/lib/supabase";
import { rebuildCallScoreMetrics } from "@/lib/call-score-metrics";
import { guard, dbError } from "../../_shared";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 120;

export async function POST() {
  const g = await guard("documents:write");
  if ("response" in g) return g.response;
  const { admin } = g;
  try {
    const res = await rebuildCallScoreMetrics(supabaseAdmin(), admin.orgId, { createdBy: admin.email });
    return Response.json({ ok: true, ...res });
  } catch (e) {
    return dbError(e);
  }
}
