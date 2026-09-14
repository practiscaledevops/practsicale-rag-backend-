// RAG answer-quality metrics from usage_events (grounded / fabricated_citations,
// added in migration 0010). Server-only. These are the signals a CEO cares about
// for trust: how often answers are grounded vs refused, how often the model cited
// something that wasn't retrieved, and how fast answers come back.
//
// NOTE: "top unanswered questions" and "most-used sources" need per-answer query
// + retrieved-source logging that isn't captured yet — a follow-up. Everything
// here is computed from existing rows, so it needs no new schema.

import { supabaseAdmin } from "@/lib/supabase";

export interface RagQuality {
  days: number;
  totalAnswers: number;
  analyzed: number; // answers with a grounded verdict recorded
  grounded: number;
  ungrounded: number;
  groundedRate: number | null; // grounded / analyzed
  fabricationEvents: number; // answers with >=1 fabricated citation
  fabricatedCitations: number; // total fabricated ids
  fabricationRate: number | null; // fabricationEvents / analyzed
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  series: { date: string; answers: number; grounded: number; groundedRate: number | null }[];
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export async function getRagQuality(orgId: string, days = 30): Promise<RagQuality> {
  const db = supabaseAdmin();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const { data } = await db
    .from("usage_events")
    .select("grounded, fabricated_citations, latency_ms, created_at")
    .eq("org_id", orgId)
    .eq("kind", "chat")
    .gte("created_at", since)
    .limit(50_000);

  const rows = (data ?? []) as {
    grounded: boolean | null;
    fabricated_citations: number | null;
    latency_ms: number | null;
    created_at: string;
  }[];

  let analyzed = 0;
  let grounded = 0;
  let ungrounded = 0;
  let fabricationEvents = 0;
  let fabricatedCitations = 0;
  const latencies: number[] = [];
  const byDay = new Map<string, { answers: number; grounded: number }>();

  for (const r of rows) {
    const day = r.created_at.slice(0, 10);
    const d = byDay.get(day) ?? { answers: 0, grounded: 0 };
    d.answers += 1;

    if (r.grounded !== null && r.grounded !== undefined) {
      analyzed += 1;
      if (r.grounded) {
        grounded += 1;
        d.grounded += 1;
      } else {
        ungrounded += 1;
      }
    }
    const fab = Number(r.fabricated_citations ?? 0);
    if (fab > 0) {
      fabricationEvents += 1;
      fabricatedCitations += fab;
    }
    if (typeof r.latency_ms === "number" && Number.isFinite(r.latency_ms)) latencies.push(r.latency_ms);
    byDay.set(day, d);
  }

  latencies.sort((a, b) => a - b);
  const series = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({
      date,
      answers: v.answers,
      grounded: v.grounded,
      groundedRate: v.answers > 0 ? v.grounded / v.answers : null,
    }));

  return {
    days,
    totalAnswers: rows.length,
    analyzed,
    grounded,
    ungrounded,
    groundedRate: analyzed > 0 ? grounded / analyzed : null,
    fabricationEvents,
    fabricatedCitations,
    fabricationRate: analyzed > 0 ? fabricationEvents / analyzed : null,
    avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    p95LatencyMs: percentile(latencies, 95),
    series,
  };
}
