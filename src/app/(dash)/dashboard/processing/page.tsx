import { requireAdmin } from "@/lib/auth/admin";
import { supabaseAdmin } from "@/lib/supabase";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert } from "@/components/ui/Alert";
import { ProcessingClient, type RunRow } from "./ProcessingClient";

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

  const { data, error } = await db
    .from("ingestion_runs")
    .select(SELECT)
    .eq("org_id", admin.orgId)
    .order("started_at", { ascending: false })
    .limit(LIMIT);

  // Resolve data_source_id -> name with a second query (the demo client cannot
  // embed joins), so each run can show a readable source label.
  const { data: srcRows } = await db
    .from("data_sources")
    .select("id, name")
    .eq("org_id", admin.orgId);
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
      <PageHeader
        title="Processing"
        description="Live view of everything ingested and synced into the knowledge base — and any errors."
      />

      {error ? (
        <Alert tone="danger" title="Could not load processing activity">
          {error.message}
        </Alert>
      ) : (
        <ProcessingClient initialRuns={runs} />
      )}
    </div>
  );
}
