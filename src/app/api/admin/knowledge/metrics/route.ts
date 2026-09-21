// /api/admin/knowledge/metrics — Performance Memory (structured numbers).
//   GET  ?key=&limit=            → { metrics, keys }
//   POST { metricKey, label?, value, unit?, periodStart?, periodEnd?, dimensions?,
//          entityId?, objectRef?, note? }

import { supabaseAdmin } from "@/lib/supabase";
import { insertMetric, listMetrics } from "@/lib/performance-memory";
import { getObjectByRef } from "@/lib/knowledge-store";
import { guard, dbError, str, strOrNull, num } from "../_shared";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

export async function GET(req: Request) {
  const g = await guard();
  if ("response" in g) return g.response;
  const { admin } = g;
  const url = new URL(req.url);
  try {
    const metrics = await listMetrics(supabaseAdmin(), admin.orgId, { metricKey: str(url.searchParams.get("key"), 80) || undefined, limit: Math.min(500, Number(url.searchParams.get("limit") ?? 300)) });
    const keys = Array.from(new Set(metrics.map((m) => m.metric_key)));
    return Response.json({ metrics, keys });
  } catch (e) {
    return dbError(e);
  }
}

export async function POST(req: Request) {
  const g = await guard("documents:write");
  if ("response" in g) return g.response;
  const { admin } = g;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const metricKey = str(body.metricKey, 80);
  const value = num(body.value);
  if (!metricKey || value === null) return Response.json({ error: "metricKey and numeric value are required" }, { status: 400 });
  const db = supabaseAdmin();
  try {
    let objectId: string | null = null;
    const ref = str(body.objectRef, 32);
    if (ref) objectId = (await getObjectByRef(db, admin.orgId, ref))?.id ?? null;
    const row = await insertMetric(db, admin.orgId, {
      metricKey,
      label: strOrNull(body.label, 120),
      value,
      unit: strOrNull(body.unit, 20),
      periodStart: strOrNull(body.periodStart, 10),
      periodEnd: strOrNull(body.periodEnd, 10),
      dimensions: body.dimensions && typeof body.dimensions === "object" ? (body.dimensions as Record<string, unknown>) : {},
      entityId: strOrNull(body.entityId, 64),
      objectId,
      note: strOrNull(body.note, 500),
      source: str(body.source, 40) || "manual",
      createdBy: admin.email,
    });
    return Response.json({ ok: true, metric: row });
  } catch (e) {
    return dbError(e);
  }
}
