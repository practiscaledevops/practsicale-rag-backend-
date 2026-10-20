import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Pull-connector dates: metadata.call_date is normalised to created_at's date
// part (the isoDatePart regex once lacked its backslashes and never matched), while
// the transcript document's hashed body keeps the source's date string verbatim
// so an already-stored transcript is skipped, not re-ingested, on a back-fill.
const m = vi.hoisted(() => ({ ingestOne: vi.fn(), metadata: vi.fn() }));

vi.mock("@/lib/ingest", () => ({ ingestOne: m.ingestOne }));
vi.mock("@/lib/connectors/sync-document", () => ({ syncSourceDocument: m.ingestOne, syncSourceMetadata: m.metadata }));
vi.mock("@/lib/net-guard", () => ({ assertPublicUrl: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => ({}) }));

import { backfillTranscripts, runPull, syncScoringRecord, refreshScoringMetadata, type DataSourceRow } from "@/lib/connectors/pull";
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
  it("fetches one authoritative scalar revision, preserving cleared status without reading or embedding transcripts", async()=>{
    respondWith([{id:"r1",created_at:"2026-10-19T10:00:00Z",updated_at:"2026-10-20T10:00:00Z",call_status:null,ticket_category:"high_ticket",overall_score:40,call_outcome:"FOLLOW_UP"}]);
    await refreshScoringMetadata({} as SupabaseClient,SOURCE,"r1");
    const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
    expect(url.searchParams.get("metadata_only")).toBe("true");expect(url.searchParams.get("report_id")).toBe("r1");expect(fetch).toHaveBeenCalledOnce();
    expect(m.metadata).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({recordId:"r1",metadata:expect.objectContaining({call_status:null,ticket_category:"high_ticket",source_updated_at:"2026-10-20T10:00:00Z",call_outcome:"FOLLOW_UP",overall_score:40})}));
    expect(m.ingestOne).not.toHaveBeenCalled();
  });
  it("hashes an identical transcript body through backfill and webhook despite outer padding", async () => {
    respondWith([{ id: "r1", created_at: "2026-10-19T10:00:00Z", updated_at: "2026-10-19T11:00:00Z", transcript: " \nConsultant: Complete evidence\nProspect: Answer\n " }]);
    await backfillTranscripts(SOURCE, { db: {} as SupabaseClient });
    const swept = ingested()[0].text;
    m.ingestOne.mockClear();
    await syncScoringRecord({} as SupabaseClient, SOURCE, "r1");
    expect(ingested()[1].text).toBe(swept);
    expect(swept.endsWith("Prospect: Answer")).toBe(true);
  });
  it("requests oldest-updated-first ordering even on a reset reconciliation cursor", async () => {
    respondWith([]);
    const q = {
      insert: () => q, select: () => q, update: () => q, eq: () => q,
      single: async () => ({ data: { id: "run" }, error: null }),
      then: (done: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(done),
    };
    const result = await runPull({ ...SOURCE, kind: "pull_http", cursor_field: "updated_at", cursor_param: "updated_since", cursor_value: null }, { db: { from: () => q } as unknown as SupabaseClient });
    expect(result.status).toBe("success");
    expect(new URL(vi.mocked(fetch).mock.calls[0][0] as string).searchParams.get("updated_since")).toBe("1970-01-01T00:00:00.000Z");
  });

  it("bounds transcript-heavy pages and still fetches the complete backfill", async () => {
    const records = Array.from({ length: 26 }, (_, i) => ({ id: `r${i}`, transcript: "Consultant: Synthetic pagination check" }));
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input);
      expect(url.searchParams.get("limit")).toBe("25");
      const offset = Number(url.searchParams.get("offset"));
      return Response.json(records.slice(offset, offset + 25));
    }));
    const result = await backfillTranscripts({ ...SOURCE, query_params: { limit: "500" } }, { db: {} as SupabaseClient });
    expect(result.calls).toBe(26);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refreshes the exact current source row and its transcript, ignoring the old creation cursor", async () => {
    respondWith([{ id: "r1", consultant_name: "Test consultant", created_at: "2026-09-01T10:00:00Z", updated_at: "2026-10-19T10:00:00Z", call_status: "closed", call_outcome: "FOLLOW_UP", ticket_category: "high_ticket", transcript: "Consultant: A synthetic transcript" }]);
    await syncScoringRecord({} as SupabaseClient, { ...SOURCE, cursor_field: "created_at", cursor_param: "since", cursor_value: "2026-10-18T00:00:00Z" }, "r1");
    const requested = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
    expect(requested.searchParams.get("report_id")).toBe("r1");
    expect(requested.searchParams.has("since")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [report, transcript] = ingested();
    for (const doc of [report, transcript]) {
      expect(doc.metadata).toMatchObject({ source_record_id: "r1", call_status: "closed", ticket_category: "high_ticket", source_updated_at: "2026-10-19T10:00:00Z" });
      expect(doc.text).toContain("Current CRM status: Closed");
      expect(doc.text).toContain("Closing type: High Ticket");
    }
  });

  it("fails without writing when the source API has no revision or ignores the report filter", async () => {
    respondWith([{ id: "r1" }]);
    await expect(syncScoringRecord({} as SupabaseClient, SOURCE, "r1")).rejects.toThrow("no revision");
    respondWith([{ id: "wrong-report", updated_at: "2026-10-19T10:00:00Z" }]);
    await expect(syncScoringRecord({} as SupabaseClient, SOURCE, "r1")).rejects.toThrow("requested report");
    expect(m.ingestOne).not.toHaveBeenCalled();
  });

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
