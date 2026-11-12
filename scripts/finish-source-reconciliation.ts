// Resume bounded normal syncs, recording each checkpoint. Does not move a
// checkpoint by hand or alter source calls. Stops on failure or after six runs.
import {loadEnvConfig} from "@next/env";
import {writeFileSync} from "node:fs";
import {resolve} from "node:path";
loadEnvConfig(process.cwd());
async function main(){
 const {supabaseAdmin}=await import("../src/lib/supabase");
 const {runPull}=await import("../src/lib/connectors/pull");
 const db=supabaseAdmin(),runs:unknown[]=[];
 for(let i=0;i<6;i++){
  const {data:source,error}=await db.from("data_sources").select("*").eq("slug","call-scoring").eq("is_active",true).single();
  if(error||!source)throw Error("Active scoring source unavailable");
  const result=await runPull(source,{db,trigger:"manual",deadlineAt:Date.now()+220000});
  const {data:checkpoint,error:readError}=await db.from("data_sources").select("cursor_value,cursor_record_id,last_status,last_run_at").eq("id",source.id).single();
  if(readError)throw Error("Checkpoint verification unavailable");
  const row={...result,checkpoint};runs.push(row);
  writeFileSync(resolve("../verification/reconciliation-finished-2026-11-12.json"),JSON.stringify({complete:result.status==="success"&&!result.error,runs},null,2));
  console.log(JSON.stringify(row));
  if(result.status!=="success")throw Error("Source reconciliation failed");
  if(!result.error)return;
 }
 throw Error("Reconciliation has more work after six bounded runs");
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
