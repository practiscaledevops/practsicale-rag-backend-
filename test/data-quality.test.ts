import {describe,it,expect,vi} from "vitest";
const state=vi.hoisted(()=>({fail:false}));
vi.mock("@/lib/supabase",()=>({supabaseAdmin:()=>({from:(table:string)=>{
 let after="",limit=200;const q:any={};
 for(const method of ["select","eq","order"])q[method]=()=>q;
 q.gt=(_field:string,value:string)=>{after=value;return q;};
 q.limit=(value:number)=>{limit=value;return q;};
 q.then=(resolve:(value:unknown)=>unknown)=>{
  const docs=Array.from({length:2001},(_,i)=>({id:String(i).padStart(5,"0"),title:"Document",source_type:"document",updated_at:new Date().toISOString(),metadata:{},chunks:[{count:i===2000?0:1}]}));
  return Promise.resolve({data:table==="documents"?docs.filter(d=>d.id>after).slice(0,limit):[],error:state.fail&&table==="documents"?{message:"timeout"}:null}).then(resolve);
 };
 return q;
}})}));
import {getDataQuality} from "@/lib/data-quality";
describe("complete library health",()=>{
 it("includes problems beyond the former 2000-document cutoff",async()=>{
  state.fail=false;
  const result=await getDataQuality("org");
  expect(result.totalDocuments).toBe(2001);
  expect(result.counts.unsearchable).toBe(1);
  expect(result.unsearchable[0].id).toBe("02000");
 });
 it("does not report a healthy empty library on a database failure",async()=>{
  state.fail=true;
  await expect(getDataQuality("org")).rejects.toThrow("unavailable");
  state.fail=false;
 });
});
