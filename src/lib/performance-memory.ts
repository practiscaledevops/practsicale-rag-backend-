// Performance Memory — the structured-numbers half of the Brain. Where RAG gives
// the model conversations and knowledge, this gives it the facts and numbers
// ("NEMT close rate fell from 17.2% to 11.8%") so it can reason from data →
// evidence → action. Server-only.

import type { SupabaseClient } from "@supabase/supabase-js";
import { slugify } from "@/lib/intelligence-taxonomy";

export interface MetricRow {
  id: string;
  metric_key: string;
  label: string | null;
  entity_id: string | null;
  dimensions: Record<string, unknown>;
  period_start: string | null;
  period_end: string | null;
  value: number;
  unit: string | null;
  source: string;
  object_id: string | null;
  note: string | null;
  created_at: string;
}

export interface MetricInput {
  metricKey: string;
  label?: string | null;
  entityId?: string | null;
  dimensions?: Record<string, unknown>;
  periodStart?: string | null;
  periodEnd?: string | null;
  value: number;
  unit?: string | null;
  source?: string;
  objectId?: string | null;
  note?: string | null;
  createdBy?: string | null;
}

export async function insertMetric(db: SupabaseClient, orgId: string, m: MetricInput): Promise<MetricRow | null> {
  const { data, error } = await db
    .from("metrics")
    .insert({
      org_id: orgId,
      metric_key: slugify(m.metricKey),
      label: m.label ?? null,
      entity_id: m.entityId ?? null,
      dimensions: m.dimensions ?? {},
      period_start: m.periodStart ?? null,
      period_end: m.periodEnd ?? null,
      value: m.value,
      unit: m.unit ?? null,
      source: m.source ?? "manual",
      object_id: m.objectId ?? null,
      note: m.note ?? null,
      created_by: m.createdBy ?? null,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as MetricRow;
}

export async function listMetrics(
  db: SupabaseClient,
  orgId: string,
  opts: { metricKey?: string; limit?: number } = {}
): Promise<MetricRow[]> {
  try {
    let q = db.from("metrics").select("*").eq("org_id", orgId);
    if (opts.metricKey) q = q.eq("metric_key", slugify(opts.metricKey));
    const { data } = await q.order("period_start", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).limit(opts.limit ?? 200);
    return (data ?? []) as MetricRow[];
  } catch {
    return [];
  }
}

const STOP = new Set(["the", "a", "an", "of", "for", "and", "or", "our", "my", "is", "are", "what", "how", "why", "to", "in", "on", "with", "rate", "rates", "number", "numbers", "data"]);

/** A metric row as the chat stream's `performance` event carries it (JSON-safe). */
export type MetricEventRow = {
  key: string;
  label: string | null;
  value: number;
  unit: string | null;
  period_start: string | null;
  period_end: string | null;
  dimensions: Record<string, string | number | boolean | null>;
  source: string;
};

/** The rows the answer reasoned from, flattened for the client (numeric comes back as text; nested dimensions are stringified). */
export function metricEventRows(rows: MetricRow[]): MetricEventRow[] {
  return rows.map((m) => {
    const dimensions: MetricEventRow["dimensions"] = {};
    for (const [k, v] of Object.entries(m.dimensions ?? {})) {
      dimensions[k] = v == null ? null : typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : JSON.stringify(v);
    }
    return { key: m.metric_key, label: m.label ?? null, value: Number(m.value), unit: m.unit ?? null, period_start: m.period_start ?? null, period_end: m.period_end ?? null, dimensions, source: m.source };
  });
}

/**
 * Pull the metrics relevant to a request (by metric key / label / dimension
 * keyword match) and render them as a compact Markdown table for the prompt.
 * Returns the rows too, so the answer can show the numbers it used. Empty when
 * nothing matches or the table doesn't exist yet.
 */
export async function fetchPerformanceBlock(
  db: SupabaseClient,
  orgId: string,
  q: { query: string; keyConcepts: string[]; entities: string[]; needsNumbers: boolean }
): Promise<{ block: string; count: number; keys: string[]; metrics: MetricRow[] }> {
  const empty = { block: "", count: 0, keys: [], metrics: [] };
  const terms = Array.from(
    new Set(
      [...q.keyConcepts, ...q.entities, ...q.query.split(/\s+/)]
        .map((t) => slugify(t))
        .flatMap((t) => t.split("_"))
        .filter((t) => t.length > 2 && !STOP.has(t))
    )
  ).slice(0, 12);
  if (terms.length === 0) return empty;

  let rows: MetricRow[] = [];
  try {
    const ors = terms.flatMap((t) => [`metric_key.ilike.%${t}%`, `label.ilike.%${t}%`]).join(",");
    const { data } = await db
      .from("metrics")
      .select("*")
      .eq("org_id", orgId)
      .or(ors)
      .order("period_start", { ascending: false, nullsFirst: false })
      .limit(q.needsNumbers ? 40 : 16);
    rows = (data ?? []) as MetricRow[];
  } catch {
    return empty;
  }
  if (rows.length === 0) return empty;

  const lines = rows.map((r) => {
    const period = r.period_start ? `${r.period_start}${r.period_end ? ` → ${r.period_end}` : ""}` : "—";
    const dims = Object.entries(r.dimensions ?? {})
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(", ");
    const val = `${Number(r.value).toLocaleString("en-US", { maximumFractionDigits: 3 })}${r.unit ? ` ${r.unit}` : ""}`;
    return `| ${r.label ?? r.metric_key} | ${period} | ${val} | ${dims || "—"} | ${r.source} |`;
  });
  const block = `| Metric | Period | Value | Dimensions | Source |\n|---|---|---|---|---|\n${lines.join("\n")}`;
  return { block, count: rows.length, keys: Array.from(new Set(rows.map((r) => r.metric_key))), metrics: rows };
}
