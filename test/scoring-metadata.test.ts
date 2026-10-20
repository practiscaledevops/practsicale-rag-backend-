import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
const m = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("@/lib/ingest", () => ({ prepareChunkRows: m.prepare }));
import { syncSourceMetadata } from "@/lib/connectors/sync-document";

beforeEach(()=>vi.clearAllMocks());
function database(rows: unknown[], error: unknown = null) {
  const q: any = { select: vi.fn(()=>q), eq: vi.fn(()=>q), in: vi.fn(()=>q), order: vi.fn(async()=>({ data: rows, error })) };
  const rpc = vi.fn(async(_name: string, _args: Record<string, any>)=>({data:[{document_id:"d",skipped:false}],error:null}));
  return { q, rpc, db: {from:vi.fn(()=>q), rpc} as unknown as SupabaseClient };
}
describe("fast scoring publication",()=>{
  it("atomically updates both identities and all chunks without embeddings, retaining indexed revision",async()=>{
    const {db,q,rpc}=database(["call_score","transcript"].map((type,i)=>({id:`d${i}`,source_type:type,title:type,content_hash:`hash${i}`,metadata:{source_updated_at:"2026-10-19T00:00:00Z"},chunks:[{count:15}]})));
    expect(await syncSourceMetadata(db,{orgId:"org",dataSourceId:"source",recordId:"call",metadata:{source_updated_at:"2026-10-20T00:00:00Z",call_status:null,ticket_category:"low_ticket"}})).toBe(2);
    expect(q.eq).toHaveBeenCalledWith("org_id","org");expect(q.eq).toHaveBeenCalledWith("data_source_id","source");expect(q.eq).toHaveBeenCalledWith("metadata->>source_record_id","call");
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith("sync_source_document",expect.objectContaining({p_record_id:"call",p_chunks:null,p_metadata:{source_updated_at:"2026-10-20T00:00:00Z",source_body_updated_at:"2026-10-19T00:00:00Z",call_status:null,ticket_category:"low_ticket"}}));
    expect(m.prepare).not.toHaveBeenCalled();
  });
  it("preserves body revision across consecutive quick changes",async()=>{
    const {db,rpc}=database([{id:"d",source_type:"transcript",content_hash:"hash",metadata:{source_updated_at:"newer",source_body_updated_at:"indexed"},chunks:[{count:2}]}]);
    await syncSourceMetadata(db,{orgId:"org",dataSourceId:"source",recordId:"call",metadata:{source_updated_at:"latest"}});
    expect(rpc.mock.calls[0][1].p_metadata.source_body_updated_at).toBe("indexed");
  });
  it("leaves new or incomplete calls to the durable ingestion path and fails closed on lookup errors",async()=>{
    const {db,rpc}=database([{source_type:"transcript",chunks:[{count:0}]}]);
    expect(await syncSourceMetadata(db,{orgId:"o",dataSourceId:"s",recordId:"c",metadata:{}})).toBe(0);expect(rpc).not.toHaveBeenCalled();
    await expect(syncSourceMetadata(database([],{}).db,{orgId:"o",dataSourceId:"s",recordId:"c",metadata:{}})).rejects.toThrow("lookup failed");
  });
});
