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

import { supabaseAdmin } from "@/lib/supabase";
import { runPull, type DataSourceRow } from "@/lib/connectors/pull";
import { isDemo } from "@/lib/demo/mode";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 300;

const SOURCE_COLUMNS =
  "id, org_id, name, slug, source_type, kind, endpoint_url, http_method, auth_type, " +
  "auth_secret_ref, headers, query_params, records_path, record_id_field, cursor_field, cursor_param, cursor_value";

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed — never an open endpoint
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

async function handle(req: Request): Promise<Response> {
  if (isDemo()) return Response.json({ ok: true, demo: true, ran: [] });
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("data_sources")
    .select(SOURCE_COLUMNS)
    .eq("kind", "pull_http")
    .eq("is_active", true);

  if (error) return Response.json({ error: error.message }, { status: 500 });
  const sources = (data ?? []) as unknown as DataSourceRow[];

  const ran: Array<Record<string, unknown>> = [];
  for (const source of sources) {
    const res = await runPull(source, { trigger: "schedule", db });
    ran.push({
      source: source.name,
      status: res.status,
      fetched: res.recordsFetched,
      ingested: res.documentsIngested,
      skipped: res.documentsSkipped,
      chunks: res.chunksIngested,
      ...(res.error ? { error: res.error } : {}),
    });
  }

  return Response.json({ ok: true, count: sources.length, ran });
}

// Vercel Cron issues a GET; POST is accepted too for manual triggering.
export const GET = handle;
export const POST = handle;
