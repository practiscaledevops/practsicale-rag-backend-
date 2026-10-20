// Passive production observer: source writes MUST come from its real admin UI.
// Never sends webhooks, drains queues, or writes calls. Keeps a restoration checkpoint.
import { loadEnvConfig } from "@next/env";
import { createServerClient } from "@supabase/ssr";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
loadEnvConfig(process.cwd());
const checkpoint=resolve("../verification/live-call-latency-checkpoint.json");
const clean=(v:unknown)=>String(v??"").toLowerCase().replace(/[^a-z0-9]/g,"").replace(/closing$/,"");
const status=(v:unknown)=>clean(v)||"pending";
const fingerprint=(row:Record<string,unknown>)=>createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(row).filter(([k])=>k!=="updated_at").sort(([a],[b])=>a.localeCompare(b))))).digest("hex");
const pause=()=>new Promise(r=>setTimeout(r,400));
async function main(){
  const {supabaseAdmin}=await import("../src/lib/supabase");const db=supabaseAdmin();
  const {data:source,error}=await db.from("data_sources").select("*").eq("slug","call-scoring").single();if(error)throw error;
  async function sourceRow(id:string,full=false){
    const url=new URL(source.endpoint_url);url.searchParams.set("report_id",id);url.searchParams.set("metadata_only",String(!full));url.searchParams.set("include_transcript",String(full));
    const res=await fetch(url,{headers:{"x-api-key":process.env[source.auth_secret_ref]??""},cache:"no-store",signal:AbortSignal.timeout(15000)});
    if(!res.ok)throw Error(`Source HTTP ${res.status}`);const rows=(await res.json()).data;if(rows?.length!==1||rows[0].id!==id)throw Error("Exact call not returned");return rows[0];
  }
  if(process.argv[2]==="snapshot"){
    if(existsSync(checkpoint))throw Error("Latency checkpoint already exists; inspect restoration first");
    const old=JSON.parse(readFileSync(resolve("../verification/live-call-change-checkpoint.json"),"utf8"));const original=await sourceRow(old.recordId,true);
    if(fingerprint(original)!==old.originalFingerprint)throw Error("Previous test is not fully restored");
    const baseline=Object.fromEntries(["call_status","ticket_category","call_outcome","call_sequence","overall_score","performance_band","updated_at","created_at","consultant_name","prospect_name"].map(k=>[k,original[k]]));
    writeFileSync(checkpoint,JSON.stringify({recordId:old.recordId,original:baseline,lastRevision:original.updated_at,originalFingerprint:fingerprint(original),phases:[]},null,2));
    console.log(JSON.stringify({snapshot:true,recordId:old.recordId,status:original.call_status,ticket:original.ticket_category}));return;
  }
  const state=JSON.parse(readFileSync(checkpoint,"utf8"));const [phase,expectedStatus,expectedTicket]=process.argv.slice(3);
  if(process.argv[2]!=="watch"||!phase||!expectedStatus||!expectedTicket||state.phases.some((p:any)=>p.phase===phase))throw Error("Use watch <new phase> <status> <ticket>");
  const env=Object.fromEntries(readFileSync(resolve("../practiscale-rag-chatbot/.env.local"),"utf8").split(/\r?\n/).flatMap(line=>{const m=line.match(/^([A-Z_0-9]+)=(.*)$/);return m?[[m[1],m[2].trim().replace(/^["']|["']$/g,"")]]:[];}));
  const cookies=new Map<string,string>();const auth=createServerClient(env.NEXT_PUBLIC_SUPABASE_URL,env.NEXT_PUBLIC_SUPABASE_ANON_KEY,{cookies:{getAll:()=>[...cookies].map(([name,value])=>({name,value})),setAll:(all:{name:string;value:string}[])=>all.forEach(c=>cookies.set(c.name,c.value))}});
  if((await auth.auth.signInWithPassword({email:process.env.SETUP_ADMIN_EMAIL!,password:process.env.SETUP_ADMIN_PASSWORD!})).error)throw Error("Verification login failed");
  const day=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Karachi",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(state.original.created_at));
  const query=`give me report of ${state.original.consultant_name} calls on ${day}`;
  let version:string|undefined;let current:any=null;let brainAt=0;let reportAt=0;let reportContent="";let stop=false;
  const deadline=Date.now()+180000;const abort=new AbortController();
  function matchingReport(content:string){
    const rows=content.split("\n").filter(l=>l.startsWith("|")).map(l=>l.split("|").slice(1,-1).map(s=>s.trim()));const headers=rows.find(r=>r.some(v=>clean(v)==="currentcrmstatus"));if(!headers)return false;
    const column=(v:string)=>headers.findIndex(h=>clean(h)===clean(v));const row=rows.find(r=>clean(r[column("Prospect")])===clean(state.original.prospect_name)&&clean(r[column("Consultant")])===clean(state.original.consultant_name));
    return !!row&&status(row[column("Current CRM Status")])===status(expectedStatus)&&clean(row[column("Closing Type")])===clean(expectedTicket)&&clean(row[column("Original Call Outcome")])===clean(state.original.call_outcome);
  }
  const subscription=(async()=>{
    while(!stop&&Date.now()<deadline){
      const res=await fetch("https://practiscale-rag-chatbot.vercel.app/api/call-reports",{method:"POST",headers:{"content-type":"application/json",cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join("; ")},body:JSON.stringify({query,timeZone:"Asia/Karachi",version,waitMs:version?20000:0}),signal:abort.signal});
      const body=await res.json();if(!res.ok)throw Error(`Live report HTTP ${res.status}: ${body.error}`);
      version=body.version;
      if(!body.unchanged&&matchingReport(body.content)){reportAt=Date.now();reportContent=body.content;return;}
      if(!body.unchanged)console.log(JSON.stringify({phase,subscriptionReady:true,version}));
    }
  })();
  // Attach rejection handling immediately while source observation runs.
  let subscriptionError:unknown;void subscription.catch(e=>{subscriptionError=e;});
  console.log(JSON.stringify({watching:phase,passiveOnly:true}));
  try{
    while(Date.now()<deadline){
      if(subscriptionError)throw subscriptionError;
      if(!current){const row=await sourceRow(state.recordId);if(Date.parse(row.updated_at)>Date.parse(state.lastRevision)&&status(row.call_status)===status(expectedStatus)&&clean(row.ticket_category)===clean(expectedTicket)){current=row;console.log(JSON.stringify({phase,sourceRevision:row.updated_at,status:row.call_status,ticket:row.ticket_category}));}}
      if(current&&!brainAt){
        const [docs,chunks]=await Promise.all([db.from("documents").select("id,source_type,metadata").eq("org_id",source.org_id).eq("data_source_id",source.id).eq("metadata->>source_record_id",state.recordId),db.from("chunks").select("id,document_id,metadata").eq("org_id",source.org_id).eq("data_source_id",source.id).eq("metadata->>source_record_id",state.recordId).limit(1000)]);
        if(docs.error||chunks.error)throw Error("Brain observation failed");
        const matches=(r:any)=>Date.parse(r.metadata.source_updated_at)===Date.parse(current.updated_at)&&status(r.metadata.call_status)===status(expectedStatus)&&clean(r.metadata.ticket_category)===clean(expectedTicket)&&r.metadata.call_outcome===state.original.call_outcome&&r.metadata.call_sequence===state.original.call_sequence&&Number(r.metadata.overall_score)===Number(current.overall_score);
        if(docs.data?.length===2&&chunks.data?.length&&docs.data.every(matches)&&chunks.data.every(matches)){brainAt=Date.now();console.log(JSON.stringify({phase,brainMatched:true,seconds:(brainAt-Date.parse(current.updated_at))/1000,documents:2,chunks:chunks.data.length}));}
      }
      if(current&&brainAt&&reportAt)break;await pause();
    }
    if(!current||!brainAt||!reportAt)throw Error("Live propagation did not complete; restore source values");
    const restored=phase==="restored"?fingerprint(await sourceRow(state.recordId,true))===state.originalFingerprint:null;
    const result={phase,sourceRevision:current.updated_at,sourceToBrainSeconds:(brainAt-Date.parse(current.updated_at))/1000,sourceToSubscribedReportSeconds:(reportAt-Date.parse(current.updated_at))/1000,originalOutcomePreserved:current.call_outcome===state.original.call_outcome,sequencePreserved:current.call_sequence===state.original.call_sequence,restoredFingerprintMatches:restored,passed:restored!==false};
    state.lastRevision=current.updated_at;state.phases.push(result);writeFileSync(checkpoint,JSON.stringify(state,null,2));writeFileSync(resolve(`../verification/live-call-latency-${phase}.md`),reportContent);console.log(JSON.stringify(result));
    if(!result.passed)throw Error("Restoration fingerprint mismatch");
  }finally{stop=true;abort.abort();await subscription.catch(()=>{});await auth.auth.signOut({scope:"local"});}
}
main().catch(e=>{console.error(e instanceof Error?e.message:"Verification failed");process.exitCode=1;});
