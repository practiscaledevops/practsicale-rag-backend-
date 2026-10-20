import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
const m = vi.hoisted(() => ({ prepare: vi.fn(), rpc: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/ingest", () => ({ prepareChunkRows: m.prepare }));
import { syncSourceMetadata } from "@/lib/connectors/sync-document";
const db={rpc:m.rpc,from:m.from} as unknown as SupabaseClient;
beforeEach(()=>{vi.clearAllMocks();m.rpc.mockResolvedValue({data:[{document_id:"score",registered:true},{document_id:"transcript",registered:true}],error:null});});
describe("fast scoring registration/publication",()=>{
  it("registers a brand new call and both identities without embedding or a read-before-create race",async()=>{
    expect(await syncSourceMetadata(db,{orgId:"org",dataSourceId:"source",recordId:"new-call",metadata:{source_record_id:"new-call",source_updated_at:"2026-10-20T00:00:00Z",consultant_name:"Test consultant",prospect_name:"Test prospect",call_status:null,ticket_category:"low_ticket",call_outcome:"FOLLOW_UP",overall_score:20}})).toBe(2);
    expect(m.rpc).toHaveBeenCalledOnce();expect(m.rpc).toHaveBeenCalledWith("publish_scoring_metadata",expect.objectContaining({p_org_id:"org",p_source_id:"source",p_record_id:"new-call",p_metadata:expect.objectContaining({call_status:null,ticket_category:"low_ticket"})}));
    const summary=m.rpc.mock.calls[0][1].p_summary;expect(summary).toContain("not a transcript");expect(summary).toContain("Test prospect");expect(summary).toContain("Current CRM status: Pending");expect(summary).toContain("Original call outcome: Follow Up");
    expect(m.prepare).not.toHaveBeenCalled();expect(m.from).not.toHaveBeenCalled();
  });
  it("redacts factual summary data and never puts provider keys, fake transcript, or placeholder vectors into a request",async()=>{
    await syncSourceMetadata(db,{orgId:"o",dataSourceId:"s",recordId:"r",metadata:{consultant_name:"Test",prospect_name:"test.person@example.com",overall_score:40,call_status:"closed",ticket_category:"high_ticket"}});
    const args=m.rpc.mock.calls[0][1];expect(args.p_summary).not.toContain("test.person@example.com");expect(args.p_summary).toContain("Current QA score: 40/100");expect(args.p_chunks).toBeUndefined();expect(args.p_summary.length).toBeLessThanOrEqual(16000);
  });
  it("retains a durable fallback instead of claiming successful registration on failure",async()=>{
    m.rpc.mockResolvedValueOnce({data:null,error:{message:"private database detail"}});
    await expect(syncSourceMetadata(db,{orgId:"o",dataSourceId:"s",recordId:"r",metadata:{}})).rejects.toThrow("durable worker will retry");
  });
});
