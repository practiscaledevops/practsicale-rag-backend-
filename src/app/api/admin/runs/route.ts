// GET /api/admin/runs — recent ingestion runs for the signed-in admin's org.
//
// Read-only. Powers the Processing monitor: one row per ingest attempt (manual
// sync, scheduled sync, push webhook, or file upload), newest first, capped.
//
// SECURITY: org_id is resolved SERVER-SIDE from the admin session (never from the
// request) and every query is filtered by it, so a request can only ever read
// runs within the caller's own tenant.
//
// The data-source NAME is resolved with a SECOND small query (id -> name map)
// rather than a PostgREST embedded join: the in-memory demo client used in DEMO
// MODE ignores embedded selects, so a join would silently drop the name there.

import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

// Newest runs only — a monitor never needs the full history in one request.
const LIMIT = 100;

// Columns kept in sync with the Processing page's server-side query.
const SELECT =
  "id, data_source_id, trigger, status, documents_ingested, " +
  "chunks_ingested, documents_skipped, error, started_at, finished_at";

// Raw ingestion_runs row (source_name is added after the name lookup).
interface RawRun {
  id: string;
  data_source_id: string | null;
  trigger: string;
  status: string;
  documents_ingested: number;
  chunks_ingested: number;
  documents_skipped: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export async function GET() {
  let admin;
  try {
    // Ingestion runs belong to data sources — gate on that resource.
    admin = await requireAdmin("data_sources:read");
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  const db = supabaseAdmin();

  const { data, error } = await db
    .from("ingestion_runs")
    .select(SELECT)
    .eq("org_id", admin.orgId)
    .order("started_at", { ascending: false })
    .limit(LIMIT);

  if (error) return Response.json({ error: error.message }, { status: 500 });

  // Resolve data_source_id -> name so the monitor can show a human label.
  const { data: srcRows } = await db
    .from("data_sources")
    .select("id, name")
    .eq("org_id", admin.orgId);
  const nameById = new Map<string, string>();
  for (const s of srcRows ?? []) nameById.set(s.id as string, s.name as string);

  const runs = ((data as unknown as RawRun[]) ?? []).map((r) => ({
    ...r,
    source_name: r.data_source_id ? nameById.get(r.data_source_id) ?? null : null,
  }));

  return Response.json({ runs });
}
