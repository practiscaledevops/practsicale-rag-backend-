// GET /api/admin/usage — usage aggregates for the signed-in admin's org.
//
// Read-only. Powers the Analytics dashboard (totals, daily time series, and
// breakdowns by model/tier and by API key).
//
// SECURITY: org_id is resolved SERVER-SIDE from the admin session (never from the
// request). Requires the 'analytics' permission; super_admin bypasses. Every
// query is filtered by the resolved org, so it can never read another tenant.
//
// Query params:
//   days   lookback window in days (default 30, clamped 1..365)

import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

interface UsageRow {
  api_key_id: string | null;
  kind: string;
  model: string | null;
  tier: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | string;
  created_at: string;
}

/** A running accumulator for one breakdown bucket. */
interface Bucket {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

function emptyBucket(): Bucket {
  return { requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
}

function add(b: Bucket, row: UsageRow): void {
  b.requests += 1;
  b.input_tokens += row.input_tokens ?? 0;
  b.output_tokens += row.output_tokens ?? 0;
  b.cost_usd += Number(row.cost_usd ?? 0);
}

/** UTC date key (YYYY-MM-DD) for bucketing a timestamp into a day. */
function dayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export async function GET(req: Request) {
  let admin;
  try {
    admin = await requireAdmin("analytics:read");
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  const url = new URL(req.url);
  const rawDays = Number.parseInt(url.searchParams.get("days") ?? "30", 10);
  const days = Number.isFinite(rawDays) ? Math.min(365, Math.max(1, rawDays)) : 30;
  const since = new Date(Date.now() - days * 86_400_000);
  const sinceIso = since.toISOString();

  const db = supabaseAdmin();

  // Pull the raw events for the window (capped) and aggregate in memory. A cap
  // keeps a single request bounded; heavier reporting would move to SQL rollups.
  const { data, error } = await db
    .from("usage_events")
    .select("api_key_id, kind, model, tier, input_tokens, output_tokens, cost_usd, created_at")
    .eq("org_id", admin.orgId)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true })
    .limit(50_000);

  if (error) return Response.json({ error: error.message }, { status: 500 });
  const rows = (data ?? []) as UsageRow[];

  // Key id -> display name, so the by-key breakdown is human-readable.
  const { data: keyRows } = await db
    .from("api_keys")
    .select("id, name, key_prefix")
    .eq("org_id", admin.orgId);
  const keyName = new Map<string, string>();
  for (const k of keyRows ?? []) {
    keyName.set(k.id as string, (k.name as string) || (k.key_prefix as string) || (k.id as string).slice(0, 8));
  }

  const totals = emptyBucket();
  const byDay = new Map<string, Bucket>();
  const byModel = new Map<string, Bucket & { model: string; tier: string }>();
  const byKey = new Map<string, Bucket & { api_key_id: string | null; name: string }>();

  for (const row of rows) {
    add(totals, row);

    const dk = dayKey(row.created_at);
    if (!byDay.has(dk)) byDay.set(dk, emptyBucket());
    add(byDay.get(dk)!, row);

    const model = row.model ?? "unknown";
    const tier = row.tier ?? "—";
    const mk = `${model}|${tier}`;
    if (!byModel.has(mk)) byModel.set(mk, { model, tier, ...emptyBucket() });
    add(byModel.get(mk)!, row);

    const kk = row.api_key_id ?? "internal";
    if (!byKey.has(kk)) {
      byKey.set(kk, {
        api_key_id: row.api_key_id,
        name: row.api_key_id ? keyName.get(row.api_key_id) ?? row.api_key_id.slice(0, 8) : "Dashboard / internal",
        ...emptyBucket(),
      });
    }
    add(byKey.get(kk)!, row);
  }

  // Build a continuous daily series (zero-fill gaps) so the chart has no holes.
  const series: Array<{ date: string } & Bucket> = [];
  const cursor = new Date(sinceIso.slice(0, 10) + "T00:00:00.000Z");
  const end = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
  while (cursor <= end) {
    const dk = cursor.toISOString().slice(0, 10);
    series.push({ date: dk, ...(byDay.get(dk) ?? emptyBucket()) });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const byModelArr = [...byModel.values()].sort((a, b) => b.requests - a.requests);
  const byKeyArr = [...byKey.values()].sort((a, b) => b.requests - a.requests);

  return Response.json({
    range: { days, since: sinceIso },
    totals,
    series,
    byModel: byModelArr,
    byKey: byKeyArr,
  });
}
