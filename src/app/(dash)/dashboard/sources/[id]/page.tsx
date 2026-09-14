import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/admin";
import { supabaseAdmin } from "@/lib/supabase";
import { SourceHealthClient, type SourceHealth, type SourceRun } from "./SourceHealthClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /dashboard/sources/[id] — the health page for one data source (the call-scoring
 * connector's home). Shows connection + sync state, the cursor checkpoint, field
 * mapping, throughput, and run history; the client adds Sync-now / Pause controls.
 * org_id is resolved server-side and every read is filtered by it.
 */
export default async function SourceHealthPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const admin = await requireAdmin();
  const db = supabaseAdmin();

  const { data: source } = await db
    .from("data_sources")
    .select(
      "id, name, slug, source_type, kind, endpoint_url, http_method, auth_type, records_path, record_id_field, cursor_field, cursor_param, cursor_value, schedule_cron, is_active, last_run_at, last_status, created_at"
    )
    .eq("id", id)
    .eq("org_id", admin.orgId)
    .maybeSingle();

  if (!source) notFound();
  const s = source as Record<string, unknown>;

  const { data: runsData } = await db
    .from("ingestion_runs")
    .select("status, trigger, documents_ingested, chunks_ingested, documents_skipped, error, started_at, finished_at")
    .eq("data_source_id", id)
    .order("started_at", { ascending: false })
    .limit(40);

  const runs: SourceRun[] = ((runsData ?? []) as Record<string, unknown>[]).map((r) => ({
    status: String(r.status ?? "running"),
    trigger: String(r.trigger ?? "manual"),
    ingested: Number(r.documents_ingested ?? 0),
    chunks: Number(r.chunks_ingested ?? 0),
    skipped: Number(r.documents_skipped ?? 0),
    error: (r.error as string) ?? null,
    startedAt: String(r.started_at ?? ""),
    finishedAt: (r.finished_at as string) ?? null,
  }));

  // Throughput aggregates + average time-to-searchable from successful runs.
  const totals = runs.reduce(
    (acc, r) => {
      acc.ingested += r.ingested;
      acc.chunks += r.chunks;
      acc.skipped += r.skipped;
      if (r.status === "success" && r.finishedAt) {
        const dur = new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime();
        if (dur > 0) {
          acc.durMs += dur;
          acc.durCount += 1;
        }
      }
      return acc;
    },
    { ingested: 0, chunks: 0, skipped: 0, durMs: 0, durCount: 0 }
  );
  const lastSuccessAt = runs.find((r) => r.status === "success")?.finishedAt ?? null;

  const health: SourceHealth = {
    id: String(s.id),
    name: String(s.name ?? "Data source"),
    sourceType: String(s.source_type ?? "document"),
    kind: String(s.kind ?? "upload"),
    endpointUrl: (s.endpoint_url as string) ?? null,
    httpMethod: String(s.http_method ?? "GET"),
    authType: String(s.auth_type ?? "none"),
    recordsPath: (s.records_path as string) ?? null,
    recordIdField: (s.record_id_field as string) ?? null,
    cursorField: (s.cursor_field as string) ?? null,
    cursorParam: (s.cursor_param as string) ?? null,
    cursorValue: (s.cursor_value as string) ?? null,
    scheduleCron: (s.schedule_cron as string) ?? null,
    isActive: Boolean(s.is_active),
    lastRunAt: (s.last_run_at as string) ?? null,
    lastStatus: (s.last_status as string) ?? null,
    lastSuccessAt,
    totalIngested: totals.ingested,
    totalChunks: totals.chunks,
    totalSkipped: totals.skipped,
    avgTimeToSearchableMs: totals.durCount > 0 ? Math.round(totals.durMs / totals.durCount) : null,
  };

  return <SourceHealthClient health={health} runs={runs} />;
}
