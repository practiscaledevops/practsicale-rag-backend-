import { requireAdmin } from "@/lib/auth/admin";
import { supabaseAdmin } from "@/lib/supabase";
import { Alert, PageHeader } from "@/components/ui";
import { ProcessingClient, type RunRow } from "./ProcessingClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Processing runs" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // always reflect the latest runs

// Kept in sync with the SELECT in /api/admin/runs (the client polls that route).
const SELECT =
  "id, data_source_id, trigger, status, documents_ingested, " +
  "chunks_ingested, documents_skipped, error, started_at, finished_at";
const LIMIT = 100;

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

export default async function ProcessingPage() {
  // requireAdmin resolves org_id server-side from the session — never client input.
  const admin = await requireAdmin();

  const db = supabaseAdmin();

  // Runs and the source id->name map are independent, so fetch them together
  // instead of one after the other. The demo client can't embed joins, so the
  // name lookup is a second query rather than a PostgREST join.
  const [runsRes, srcRes] = await Promise.all([
    db
      .from("ingestion_runs")
      .select(SELECT)
      .eq("org_id", admin.orgId)
      .order("started_at", { ascending: false })
      .limit(LIMIT),
    db.from("data_sources").select("id, name").eq("org_id", admin.orgId),
  ]);
  const { data, error } = runsRes;
  const srcRows = srcRes.data;

  const nameById = new Map<string, string>();
  for (const s of (srcRows as { id: string; name: string }[]) ?? []) {
    nameById.set(s.id, s.name);
  }

  const runs: RunRow[] = ((data as unknown as RawRun[]) ?? []).map((r) => ({
    ...r,
    source_name: r.data_source_id ? nameById.get(r.data_source_id) ?? null : null,
  }));

  return (
    <div>
      <PageHeader title="Processing runs" description="Every ingestion run, newest first." />

      {error ? (
        <Alert tone="danger" title="Couldn't load processing runs">
          <span className="text-danger">{error.message}</span>
        </Alert>
      ) : (
        <ProcessingClient initialRuns={runs} />
      )}
    </div>
  );
}
