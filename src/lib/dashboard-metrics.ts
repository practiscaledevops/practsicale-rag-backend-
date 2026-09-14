// Live metrics for the CEO control-tower Overview. All reads are org-scoped and
// wrapped so one failing query never blanks the whole page (it returns a safe
// default). Server-only (uses the service-role client). Single-org today; chunk
// counts are global because chunks carry no org_id (they inherit it via their
// document) — correct for the current single-tenant deployment.

import { supabaseAdmin } from "@/lib/supabase";

export type SourceType = "transcript" | "call_score" | "coaching" | "document";

export interface DataSourceRow {
  id: string;
  name: string;
  sourceType: string;
  kind: string;
  isActive: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  /** true when this source needs owner attention (error or stale). */
  needsAttention: boolean;
}

export interface IngestionRun {
  status: string;
  trigger: string;
  documentsIngested: number;
  chunksIngested: number;
  documentsSkipped: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ControlTowerData {
  documents: number | null;
  bySourceType: Record<SourceType, number>;
  callScores: number | null;
  totalChunks: number | null;
  embeddedChunks: number | null;
  collections: number | null;
  dataSources: DataSourceRow[];
  needsReview: number;
  runs: IngestionRun[];
  runStats: { success: number; error: number; running: number; lastSuccessAt: string | null };
  usage: {
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    byProvider: { anthropic: number; openai: number };
    chatCalls: number;
  };
}

const STALE_DAYS = 7;

/** Head-count of an org-scoped table; null on error. */
async function orgCount(table: string, orgId: string): Promise<number | null> {
  const db = supabaseAdmin();
  const { count, error } = await db
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq("org_id", orgId);
  return error ? null : count ?? 0;
}

/** Head-count of documents of a given source_type for the org. */
async function docCountByType(orgId: string, sourceType: SourceType): Promise<number> {
  const db = supabaseAdmin();
  const { count } = await db
    .from("documents")
    .select("*", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("source_type", sourceType);
  return count ?? 0;
}

/** Head-count of chunks (optionally only embedded). Global — see file note. */
async function chunkCount(embeddedOnly: boolean): Promise<number | null> {
  const db = supabaseAdmin();
  let q = db.from("chunks").select("*", { count: "exact", head: true });
  if (embeddedOnly) q = q.not("embedding", "is", null);
  const { count, error } = await q;
  return error ? null : count ?? 0;
}

/** First instant of the current month, UTC, as ISO. */
function monthStartISO(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function isStale(lastRunAt: string | null): boolean {
  if (!lastRunAt) return true;
  const t = new Date(lastRunAt).getTime();
  if (Number.isNaN(t)) return true;
  return Date.now() - t > STALE_DAYS * 86_400_000;
}

export async function getControlTowerData(orgId: string): Promise<ControlTowerData> {
  const db = supabaseAdmin();

  const [
    documents,
    transcript,
    callScore,
    coaching,
    document,
    totalChunks,
    embeddedChunks,
    collections,
    dsRes,
    runsRes,
    usageRes,
  ] = await Promise.all([
    orgCount("documents", orgId),
    docCountByType(orgId, "transcript"),
    docCountByType(orgId, "call_score"),
    docCountByType(orgId, "coaching"),
    docCountByType(orgId, "document"),
    chunkCount(false),
    chunkCount(true),
    orgCount("collections", orgId),
    db
      .from("data_sources")
      .select("id, name, source_type, kind, is_active, last_run_at, last_status")
      .eq("org_id", orgId)
      .order("name"),
    db
      .from("ingestion_runs")
      .select("status, trigger, documents_ingested, chunks_ingested, documents_skipped, error, started_at, finished_at")
      .eq("org_id", orgId)
      .order("started_at", { ascending: false })
      .limit(50),
    db
      .from("usage_events")
      .select("model, cost_usd, input_tokens, output_tokens, kind")
      .eq("org_id", orgId)
      .gte("created_at", monthStartISO()),
  ]);

  // Data sources + attention flags.
  const dataSources: DataSourceRow[] = ((dsRes.data ?? []) as Record<string, unknown>[]).map((r) => {
    const lastStatus = (r.last_status as string) ?? null;
    const lastRunAt = (r.last_run_at as string) ?? null;
    const isActive = Boolean(r.is_active);
    const needsAttention = lastStatus === "error" || (isActive && isStale(lastRunAt));
    return {
      id: String(r.id),
      name: String(r.name ?? "Untitled source"),
      sourceType: String(r.source_type ?? "document"),
      kind: String(r.kind ?? "upload"),
      isActive,
      lastRunAt,
      lastStatus,
      needsAttention,
    };
  });
  const needsReview = dataSources.filter((s) => s.needsAttention).length;

  // Ingestion runs + stats.
  const runs: IngestionRun[] = ((runsRes.data ?? []) as Record<string, unknown>[]).map((r) => ({
    status: String(r.status ?? "running"),
    trigger: String(r.trigger ?? "manual"),
    documentsIngested: Number(r.documents_ingested ?? 0),
    chunksIngested: Number(r.chunks_ingested ?? 0),
    documentsSkipped: Number(r.documents_skipped ?? 0),
    error: (r.error as string) ?? null,
    startedAt: String(r.started_at ?? ""),
    finishedAt: (r.finished_at as string) ?? null,
  }));
  const runStats = {
    success: runs.filter((r) => r.status === "success").length,
    error: runs.filter((r) => r.status === "error").length,
    running: runs.filter((r) => r.status === "running").length,
    lastSuccessAt: runs.find((r) => r.status === "success")?.finishedAt ?? null,
  };

  // Monthly usage aggregation.
  const usageRows = (usageRes.data ?? []) as {
    model: string | null;
    cost_usd: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    kind: string | null;
  }[];
  const usage = usageRows.reduce(
    (acc, r) => {
      const cost = Number(r.cost_usd ?? 0);
      acc.costUsd += cost;
      acc.inputTokens += Number(r.input_tokens ?? 0);
      acc.outputTokens += Number(r.output_tokens ?? 0);
      if ((r.model ?? "").toLowerCase().startsWith("claude")) acc.byProvider.anthropic += cost;
      else acc.byProvider.openai += cost;
      if (r.kind === "chat") acc.chatCalls += 1;
      return acc;
    },
    { costUsd: 0, inputTokens: 0, outputTokens: 0, byProvider: { anthropic: 0, openai: 0 }, chatCalls: 0 }
  );

  return {
    documents,
    bySourceType: { transcript, call_score: callScore, coaching, document },
    callScores: callScore,
    totalChunks,
    embeddedChunks,
    collections,
    dataSources,
    needsReview,
    runs,
    runStats,
    usage,
  };
}
