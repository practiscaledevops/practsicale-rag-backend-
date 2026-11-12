import {loadEnvConfig} from "@next/env";
loadEnvConfig(process.cwd());
async function main(){
 const {supabaseAdmin}=await import("../src/lib/supabase");const db=supabaseAdmin();
 const {data:s}=await db.from("data_sources").select("org_id").eq("slug","call-scoring").single();
 const {data:c,error}=await db.from("chunks").select("embedding").eq("org_id",s!.org_id).not("embedding","is",null).limit(1).single();if(error)throw error;
 const vector=typeof c.embedding==="string"?JSON.parse(c.embedding):c.embedding;
 const cases=[[],["playbook"],["business_reality"],["organizational_learning"]];
 for(const classes of cases){const start=Date.now();const r=await db.rpc("hybrid_search_lane",{p_org_id:s!.org_id,query_text:"onboarding services",query_embedding:vector,p_classes:classes,match_count:40});console.log(JSON.stringify({classes,ms:Date.now()-start,count:r.data?.length,code:r.error?.code,message:r.error?.message}));}
 const start=Date.now();const r=await db.rpc("hybrid_search_scoped",{p_org_id:s!.org_id,query_text:"onboarding services",query_embedding:vector,match_count:60});console.log(JSON.stringify({scoped:true,ms:Date.now()-start,count:r.data?.length,code:r.error?.code,message:r.error?.message}));
}
main().catch(e=>console.error(e.message));
