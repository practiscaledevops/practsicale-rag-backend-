// GET /api/cron/sync — scheduled ingestion of every active pull data source.
//
// Runs the SAME runPull() code path as the dashboard "Sync now" button, for every
// active pull_http source across all orgs. Each source pulls only NEW records
// (incremental `since` watermark), so repeated runs are cheap and idempotent.
//
// SECURITY: protected by CRON_SECRET. Vercel Cron automatically sends
// `Authorization: Bearer <CRON_SECRET>` when the env var is set (see vercel.json).
// A request without the matching secret is rejected — this is not a public route.
//
// Schedule: every 20 minutes (vercel.json). Locally, hit it on an interval
// (see README / scripts) since Vercel Cron only runs on Vercel.

import { timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { runPull, type DataSourceRow } from "@/lib/connectors/pull";
import { rebuildCallScoreMetrics } from "@/lib/call-score-metrics";
import { isDemo } from "@/lib/demo/mode";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 300;
// Leave headroom under maxDuration for the metrics refresh + finalisation writes.
const CRON_BUDGET_MS = 230_000;

const SOURCE_COLUMNS =
  "id, org_id, name, slug, source_type, kind, endpoint_url, http_method, auth_type, " +
  "auth_secret_ref, headers, query_params, records_path, record_id_field, cursor_field, cursor_param, cursor_value";

/** Constant-time string compare (length check first — a length mismatch is not secret). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed — never an open endpoint
  const header = req.headers.get("authorization") ?? "";
  // Constant-time compare so a timing side-channel can't reveal the secret.
  return safeEqual(header, `Bearer ${secret}`);
}

async function handle(req: Request): Promise<Response> {
  if (isDemo()) return Response.json({ ok: true, demo: true, ran: [] });
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("data_sources")
    .select(SOURCE_COLUMNS)
    .eq("kind", "pull_http")
    .eq("is_active", true)
    .order("last_run_at", { ascending: true, nullsFirst: true });

  if (error) return Response.json({ error: error.message }, { status: 500 });
  const sources = (data ?? []) as unknown as DataSourceRow[];

  const ran: Array<Record<string, unknown>> = [];
  // Orgs whose call-scoring source ingested new calls this run → refresh their
  // Performance Memory afterwards (best-effort; never fails the sync).
  const refreshOrgs = new Set<string>();
  // One wall-clock budget for the whole run (the function dies at maxDuration):
  // each source gets the time that is left, stops cleanly when it runs out, and
  // resumes from its cursor on the next tick. Sources are ordered by the last
  // successful run so a slow one cannot starve the others forever.
  const deadlineAt = Date.now() + CRON_BUDGET_MS;
  for (const source of sources) {
    if (Date.now() > deadlineAt) {
      ran.push({ source: source.name, status: "skipped", reason: "time budget reached" });
      continue;
    }
    const res = await runPull(source, { trigger: "schedule", db, deadlineAt });
    ran.push({
      source: source.name,
      status: res.status,
      fetched: res.recordsFetched,
      ingested: res.documentsIngested,
      skipped: res.documentsSkipped,
      chunks: res.chunksIngested,
      ...(res.error ? { error: res.error } : {}),
    });
    if (source.source_type === "call_score" && res.documentsIngested > 0) refreshOrgs.add(source.org_id);
  }

  const refreshed: Array<Record<string, unknown>> = [];
  for (const orgId of refreshOrgs) {
    // The rebuild is idempotent and runs again next tick; never start it inside
    // the function's last seconds and die mid-write.
    if (Date.now() > deadlineAt) {
      refreshed.push({ orgId, skipped: "time budget reached; next tick rebuilds" });
      continue;
    }
    try {
      const m = await rebuildCallScoreMetrics(db, orgId, { createdBy: "cron" });
      refreshed.push({ orgId, metrics: m.metricsWritten, consultants: m.consultants, snapshot: m.snapshotRef });
    } catch (e) {
      refreshed.push({ orgId, error: e instanceof Error ? e.message : "rebuild failed" });
    }
  }

  return Response.json({ ok: true, count: sources.length, ran, ...(refreshed.length ? { performanceMemory: refreshed } : {}) });
}

// Vercel Cron issues a GET; POST is accepted too for manual triggering.
export const GET = handle;
export const POST = handle;
