import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ rpc: vi.fn(), sync: vi.fn(), remove:vi.fn(), rebuild: vi.fn(), writes: vi.fn(), source: vi.fn() }));
vi.mock("@/lib/connectors/pull", () => ({ syncScoringRecord: m.sync, deleteScoringRecord:m.remove }));
vi.mock("@/lib/call-score-metrics", () => ({ rebuildCallScoreMetrics: m.rebuild }));
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => ({ rpc: m.rpc, from: (table: string) => {
  const q = {
    select: () => q, eq: () => q, in: () => q,
    maybeSingle: () => m.source(),
    update: (payload: unknown) => { m.writes(table, payload); return q; },
    delete: () => { m.writes(table, "delete"); return q; },
    then: (done: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(done),
  };
  return q;
} }) }));
import { drainScoringEvents } from "@/lib/connectors/scoring-events";
const EVENT = { id: "event", org_id: "org", data_source_id: "source", record_id: "report" };
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("SCORING_WEBHOOK_SECRET", "enabled");
  m.rpc.mockResolvedValueOnce({ data: [EVENT], error: null }).mockResolvedValue({ data: [], error: null });
  m.source.mockResolvedValue({ data: { id: "source", org_id: "org", source_type: "call_score" }, error: null });
  m.sync.mockResolvedValue(undefined); m.rebuild.mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());
describe("durable Brain inbox", () => {
  it("retries verified deletion and rebuilds totals before completing its event",async()=>{
    m.rpc.mockReset().mockResolvedValueOnce({data:[{...EVENT,operation:"delete",source_updated_at:"2026-10-20T10:00:00Z"}],error:null}).mockResolvedValue({data:[],error:null});
    expect(await drainScoringEvents()).toBe(1);expect(m.sync).not.toHaveBeenCalled();expect(m.remove).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({id:"source"}),"report","2026-10-20T10:00:00Z");expect(m.rebuild).toHaveBeenCalledOnce();
  });
  it("acknowledges only after source refresh and metrics both succeed", async () => {
    expect(await drainScoringEvents()).toBe(1);
    expect(m.sync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "source", org_id: "org" }), "report");
    expect(m.rebuild).toHaveBeenCalledWith(expect.anything(), "org", expect.anything());
    expect(m.writes).toHaveBeenCalledWith("scoring_sync_events", expect.objectContaining({ status: "completed" }));
    expect(m.writes).toHaveBeenCalledWith("scoring_sync_locks", "delete");
  });
  it.each(["source", "metrics"])("retries a %s failure and releases the organization lease", async (failure) => {
    (failure === "source" ? m.sync : m.rebuild).mockRejectedValueOnce(new Error("Temporary outage"));
    expect(await drainScoringEvents()).toBe(0);
    expect(m.writes).toHaveBeenCalledWith("scoring_sync_events", expect.objectContaining({ status: "pending", next_attempt_at: expect.any(String) }));
    expect(m.writes).not.toHaveBeenCalledWith("scoring_sync_events", expect.objectContaining({ status: "completed" }));
    expect(m.writes).toHaveBeenCalledWith("scoring_sync_locks", "delete");
  });
  it("does not claim events when the integration is disabled", async () => {
    vi.stubEnv("SCORING_WEBHOOK_SECRET", ""); expect(await drainScoringEvents()).toBe(0); expect(m.rpc).not.toHaveBeenCalled();
  });
});
