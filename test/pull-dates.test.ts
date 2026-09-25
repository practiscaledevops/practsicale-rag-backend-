import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Pull-connector dates: metadata.call_date is normalised to created_at's date
// part (the isoDatePart regex once lacked its backslashes and never matched), while
// the transcript document's hashed body keeps the source's date string verbatim
// so an already-stored transcript is skipped, not re-ingested, on a back-fill.
const m = vi.hoisted(() => ({ ingestOne: vi.fn() }));

vi.mock("@/lib/ingest", () => ({ ingestOne: m.ingestOne }));
vi.mock("@/lib/net-guard", () => ({ assertPublicUrl: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => ({}) }));

import { backfillTranscripts, type DataSourceRow } from "@/lib/connectors/pull";
import type { SupabaseClient } from "@supabase/supabase-js";

const SOURCE: DataSourceRow = {
  id: "ds-1",
  org_id: "org-1",
  name: "Call scoring",
  slug: "call-scoring",
  source_type: "call_score",
  kind: "pull",
  endpoint_url: "https://scoring.example.com/api/reports",
  http_method: "GET",
  auth_type: "none",
  auth_secret_ref: null,
  headers: null,
  query_params: null,
  records_path: null,
  record_id_field: "id",
  cursor_field: null,
  cursor_param: null,
  cursor_value: null,
};

function respondWith(records: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(records), { status: 200, headers: { "content-type": "application/json" } }))
  );
}

type IngestParams = { title: string; text: string; metadata: Record<string, unknown> };
const ingested = (): IngestParams[] => m.ingestOne.mock.calls.map((c) => c[1] as IngestParams);

beforeEach(() => {
  vi.clearAllMocks();
  m.ingestOne.mockResolvedValue({ documentId: "doc-1", chunks: 3, skipped: false });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pull connector — call dates", () => {
  it("metadata.call_date is created_at's date part; a differing reported date is kept as reported_call_date", async () => {
    respondWith([
      { id: "r1", consultant_name: "James Ephrim", prospect_name: "Acme", created_at: "2026-09-25T01:10:00.000Z", call_date: "2026-09-24", transcript: "James: Hi" },
      { id: "r2", consultant_name: "David Park", prospect_name: "Beta", created_at: "2026-09-25T09:00:00Z", transcript: "David: Hello" },
    ]);
    await backfillTranscripts(SOURCE, { db: {} as SupabaseClient });
    const [a, b] = ingested();
    expect(a.metadata).toMatchObject({ call_date: "2026-09-25", reported_call_date: "2026-09-24", created_at: "2026-09-25T01:10:00.000Z" });
    expect(b.metadata).toMatchObject({ call_date: "2026-09-25", created_at: "2026-09-25T09:00:00Z" });
    expect(b.metadata).not.toHaveProperty("reported_call_date");
  });

  it("the transcript body keeps the source's date string verbatim (stable content hash)", async () => {
    respondWith([
      { id: "r1", consultant_name: "James Ephrim", prospect_name: "Acme", created_at: "2026-09-25T01:10:00.000Z", call_date: "2026-09-24", transcript: "James: Hi" },
      { id: "r2", consultant_name: "David Park", prospect_name: "Beta", created_at: "2026-09-25T09:00:00Z", transcript: "David: Hello" },
    ]);
    await backfillTranscripts(SOURCE, { db: {} as SupabaseClient });
    const [a, b] = ingested();
    expect(a.text).toContain("\nCall date: 2026-09-24\n");
    expect(b.text).toContain("\nCall date: 2026-09-25T09:00:00Z\n");
    expect(b.title).toBe("Transcript — David Park → Beta (2026-09-25T09:00:00Z)");
  });
});
