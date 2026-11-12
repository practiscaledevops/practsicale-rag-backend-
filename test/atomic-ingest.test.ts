import {beforeEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({embed:vi.fn()}));
vi.mock("@/lib/embeddings",()=>({embedForIngest:mocks.embed}));
vi.mock("@/lib/settings",()=>({loadSettings:async()=>({settings:{features:{contextualRetrieval:false}}})}));
vi.mock("@/lib/prompts-db",()=>({getActivePrompt:vi.fn()}));
import {ingestOne,reingestDocument} from "@/lib/ingest";
const doc={id:"old-doc",source_type:"document",metadata:{source:"original"},data_source_id:null,content_hash:"old-hash",updated_at:"2026-11-12T00:00:00Z",intelligence_class:"playbooks",domain:"sales",object_id:null};
function database(){
 const from=vi.fn((table:string)=>{
   const q:any={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:doc,error:null}),then:(resolve:any)=>Promise.resolve({data:table==="document_collections"?[]:null,error:null}).then(resolve)};
   return q;
 });
 return {from,rpc:vi.fn().mockResolvedValue({data:[{document_id:"new-doc",chunks:1,skipped:false}],error:null})};
}
beforeEach(()=>{mocks.embed.mockReset();mocks.embed.mockImplementation(async(xs:string[])=>xs.map(()=>Array(1024).fill(.1)));});
describe("atomic document publication",()=>{
 it("never modifies the active version if preparing embeddings fails",async()=>{
   const db=database();mocks.embed.mockRejectedValueOnce(new Error("provider unavailable"));
   await expect(reingestDocument(db as any,{orgId:"org",documentId:doc.id,text:"Replacement evidence"})).rejects.toThrow("provider unavailable");
   expect(db.rpc).not.toHaveBeenCalled();expect(doc.content_hash).toBe("old-hash");
 });
 it("publishes metadata and complete chunks through one guarded transaction",async()=>{
   const db=database();await reingestDocument(db as any,{orgId:"org",documentId:doc.id,text:"Replacement evidence"});
   expect(db.rpc).toHaveBeenCalledTimes(1);
   const [name,args]=db.rpc.mock.calls[0];expect(name).toBe("replace_document_content");
   expect(args).toMatchObject({p_org_id:"org",p_document_id:doc.id,p_expected_hash:"old-hash",p_expected_updated_at:doc.updated_at});
   expect(args.p_chunks.length).toBeGreaterThan(0);expect(args.p_chunks[0].intelligence_class).toBe("playbooks");
   expect(args.p_chunks[0].domain).toBe("sales");
 });
 it("surfaces a revision conflict without retrying stale metadata",async()=>{
   const db=database();db.rpc.mockResolvedValueOnce({data:null,error:{message:"Document changed"}});
   await expect(reingestDocument(db as any,{orgId:"org",documentId:doc.id,text:"Replacement evidence"})).rejects.toThrow("Document changed");
   expect(db.rpc).toHaveBeenCalledTimes(1);
 });
 it("skips unchanged content before paying for embeddings",async()=>{
   const db=database();db.rpc.mockResolvedValueOnce({data:[{document_id:"existing",skipped:true,chunks:0}],error:null});
   expect(await ingestOne(db as any,{orgId:"org",sourceType:"document",text:"Known evidence"})).toEqual({documentId:"existing",skipped:true,chunks:0});
   expect(mocks.embed).not.toHaveBeenCalled();expect(db.rpc.mock.calls[0][1].p_chunks).toBeNull();
 });
 it("accepts the canonical identity when a concurrent upload wins the commit",async()=>{
   const db=database();
   let checks=0;
   db.rpc.mockImplementation(async (name, args) => {
     if (name==="claim_ingest_slot") return {data:args.p_owner,error:null};
     if (name==="release_ingest_slot") return {data:null,error:null};
     return {data:++checks<3?[]:[{document_id:"winner",skipped:true,chunks:0}],error:null};
   });
   expect(await ingestOne(db as any,{orgId:"org",sourceType:"document",text:"Shared evidence"})).toMatchObject({documentId:"winner",skipped:true});
   expect(db.from).not.toHaveBeenCalled();expect(db.rpc).toHaveBeenCalledTimes(5);
 });
 it("does not start embeddings when a peer holds the preparation reservation",async()=>{
   const db=database();
   db.rpc.mockResolvedValueOnce({data:[],error:null}).mockResolvedValueOnce({data:null,error:null});
   await expect(ingestOne(db as any,{orgId:"org",sourceType:"document",text:"Shared evidence"})).rejects.toThrow("being prepared");
   expect(mocks.embed).not.toHaveBeenCalled();
 });
 it("preserves explicitly permitted duplicate knowledge objects",async()=>{
   const db=database();await ingestOne(db as any,{orgId:"org",sourceType:"document",text:"Compiled evidence",allowDuplicate:true});
   expect(db.rpc).toHaveBeenCalledTimes(1);expect(db.rpc.mock.calls[0][1].p_allow_duplicate).toBe(true);
 });
});
