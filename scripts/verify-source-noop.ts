import {loadEnvConfig} from "@next/env";
loadEnvConfig(process.cwd());
async function main(){
 const {supabaseAdmin}=await import("../src/lib/supabase");const db=supabaseAdmin();
 const {data:s,error:se}=await db.from("data_sources").select("*").eq("slug","call-scoring").single();if(se)throw se;
 const {data:docs,error:de}=await db.from("documents").select("id,org_id,data_source_id,source_type,title,content_hash,metadata,intelligence_class,domain,updated_at").eq("org_id",s.org_id).eq("data_source_id",s.id).order("id").limit(10);if(de)throw de;
 const started=Date.now();
 for(const d of docs){
  const {data,error}=await db.rpc("sync_source_document",{p_org_id:d.org_id,p_source_id:d.data_source_id,p_source_type:d.source_type,p_record_id:d.metadata.source_record_id,p_content_hash:d.content_hash,p_title:d.title,p_metadata:d.metadata,p_lane:{intelligence_class:d.intelligence_class,domain:d.domain},p_chunks:null});
  if(error||!data?.[0]?.skipped)throw Error("Unchanged source replay failed");
  const next=await db.from("documents").select("updated_at").eq("id",d.id).single();
  if(next.error||next.data.updated_at!==d.updated_at)throw Error("Unchanged replay modified document freshness");
 }
 console.log(JSON.stringify({unchangedReplays:docs.length,preservedUpdateDates:true,ms:Date.now()-started}));
 if(process.argv.includes("--sync")){
  const {runPull}=await import("../src/lib/connectors/pull");
  const result=await runPull(s,{db,trigger:"manual",deadlineAt:Date.now()+220000});
  console.log(JSON.stringify({...result,error:result.error?"Sync incomplete; inspect run":undefined}));
  if(result.status!=="success")process.exitCode=1;
 }
}
main().catch(e=>{console.error(e.name??"Source verification failed");process.exitCode=1;});
