import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ metrics: vi.fn(), calls: [] as Record<string, unknown>[] }));
vi.mock("@/lib/ingest", () => ({ ingestOne: vi.fn(async () => ({ documentId: "snapshot" })), reingestDocument: vi.fn() }));
vi.mock("@/lib/embeddings", () => ({ embed: vi.fn(async () => [0]) }));
vi.mock("@/lib/knowledge-store", () => ({
  upsertEntity: vi.fn(async () => "entity"), nextRef: vi.fn(async () => "BR-SAL-1"),
  buildFrontmatter: vi.fn(() => ""), assembleMarkdown: vi.fn(() => "snapshot"),
  objectContextLine: vi.fn(() => "context"), objectEmbeddingText: vi.fn(() => "snapshot"), OBJECT_COLUMNS: "id",
}));
import { rebuildCallScoreMetrics } from "@/lib/call-score-metrics";
function database(): SupabaseClient {
  return { from: (table: string) => {
    const q = {
      select: () => q, eq: () => q, limit: () => q, delete: () => q, update: () => q,
      insert: (rows: unknown) => { if (table === "metrics") m.metrics(rows); return q; },
      range: async () => ({ data: m.calls.map(metadata => ({ metadata })), error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: { id: "object" }, error: null }),
      then: (done: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(done),
    }; return q;
  } } as unknown as SupabaseClient;
}
beforeEach(() => vi.clearAllMocks());
describe("current CRM outcomes in Performance Memory", () => {
  it("counts a later close despite FOLLOW_UP and excludes undecided calls despite historical CLOSED predictions", async () => {
    m.calls = [
      { call_status: "closed", call_outcome: "FOLLOW_UP" },
      { call_status: "not_closed", call_outcome: "CLOSED" },
      { call_status: null, call_outcome: "CLOSED" },
      { call_status: "pending", call_outcome: "CLOSED" },
      { call_status: "disqualified", call_outcome: "CLOSED" },
    ];
    const result = await rebuildCallScoreMetrics(database(), "org");
    expect(result).toMatchObject({ calls: 5, closeRate: 50 });
    expect(m.metrics.mock.calls[0][0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric_key: "close_rate", value: 50, dimensions: { decided_calls: 2 } }),
      expect.objectContaining({ metric_key: "consultant_close_rate", value: 50 }),
      expect.objectContaining({ metric_key: "segment_close_rate", value: 50 }),
    ]));
  });
});
