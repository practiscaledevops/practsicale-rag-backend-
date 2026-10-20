// Observe a synthetic call saved through the normal scoring application.
// Read-only: never inserts source rows, posts webhooks, or drains any queue.
import { loadEnvConfig } from "@next/env";
import { createServerClient } from "@supabase/ssr";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
loadEnvConfig(process.cwd());
const label=process.argv[2];
const consultant=process.argv.slice(3).join(" ");
const normal=(v:unknown)=>String(v??"").toLowerCase().replace(/[^a-z0-9]/g,"");
async function main(){
  if(!label?.startsWith("SYNTHETIC NEW CALL SYNC TEST")||!consultant)throw Error("Provide the clearly labeled test prospect and consultant");
  const {supabaseAdmin}=await import("../src/lib/supabase");const db=supabaseAdmin();
  const {data:source,error}=await db.from("data_sources").select("*").eq("slug","call-scoring").single();if(error)throw error;
  const startedAt=new Date().toISOString();const deadline=Date.now()+360000;
  const checkpoint=resolve("../verification/new-call-live-checkpoint.json");
  const {count:baseline,error:countError}=await db.from("documents").select("id",{count:"exact",head:true}).eq("org_id",source.org_id).eq("data_source_id",source.id).eq("source_type","transcript");if(countError)throw countError;
  const env=Object.fromEntries(readFileSync(resolve("../practiscale-rag-chatbot/.env.local"),"utf8").split(/\r?\n/).flatMap(line=>{const m=line.match(/^([A-Z_0-9]+)=(.*)$/);return m?[[m[1],m[2].trim().replace(/^["']|["']$/g,"")]]:[];}));
  const cookies=new Map<string,string>();const auth=createServerClient(env.NEXT_PUBLIC_SUPABASE_URL,env.NEXT_PUBLIC_SUPABASE_ANON_KEY,{cookies:{getAll:()=>[...cookies].map(([name,value])=>({name,value})),setAll:(all:{name:string;value:string}[])=>all.forEach(c=>cookies.set(c.name,c.value))}});
  if((await auth.auth.signInWithPassword({email:process.env.SETUP_ADMIN_EMAIL!,password:process.env.SETUP_ADMIN_PASSWORD!})).error)throw Error("Verification login failed");
  const day=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Karachi",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  const query=`give me report of ${consultant} calls on ${day}`;
  const state:any={startedAt,label,sourceId:source.id,baselineCalls:baseline,recordId:null,phase:"armed"};
  const save=()=>writeFileSync(checkpoint,JSON.stringify(state,null,2));save();
  let version:string|undefined,current:any=null,brainAt=0,reportAt=0,fullAt=0,stop=false,reportBody:any=null,subscriptionError:unknown;
  const abort=new AbortController();
  const subscription=(async()=>{
    while(!stop&&Date.now()<deadline){
      const res=await fetch("https://practiscale-rag-chatbot.vercel.app/api/call-reports",{method:"POST",headers:{"content-type":"application/json",cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join("; ")},body:JSON.stringify({query,timeZone:"Asia/Karachi",version,waitMs:version?20000:0}),signal:abort.signal});
      if(!res.ok)throw Error(`Live report HTTP ${res.status}`);const body=await res.json();version=body.version;
      if(!body.unchanged){
        if(body.content.includes(label)){reportAt=Date.now();reportBody=body;console.log(JSON.stringify({newCallInOpenSubscription:true,pendingNotice:body.content.includes("still indexing")}));return;}
        console.log(JSON.stringify({subscriptionReady:true,matchingCalls:body.count}));
      }
    }
  })();void subscription.catch(e=>{subscriptionError=e;});
  console.log(JSON.stringify({armed:true,label,baselineCalls:baseline,passiveOnly:true}));
  try{
    while(Date.now()<deadline){
      if(subscriptionError)throw subscriptionError;
      if(!current){
        const url=new URL(source.endpoint_url);url.searchParams.set("updated_since",startedAt);url.searchParams.set("limit","25");url.searchParams.set("metadata_only","true");
        const res=await fetch(url,{headers:{"x-api-key":process.env[source.auth_secret_ref]??""},cache:"no-store",signal:AbortSignal.timeout(15000)});if(!res.ok)throw Error(`Source HTTP ${res.status}`);
        current=(await res.json()).data?.find((r:any)=>r.prospect_name===label);
        if(current){state.recordId=current.id;state.source={created_at:current.created_at,updated_at:current.updated_at,call_status:current.call_status,ticket_category:current.ticket_category,call_outcome:current.call_outcome,call_sequence:current.call_sequence,overall_score:current.overall_score};state.phase="saved";save();console.log(JSON.stringify({sourceSaved:true,recordId:current.id,revision:current.updated_at}));}
      }
      if(current){
        const {data:docs,error:docError}=await db.from("documents").select("id,source_type,metadata").eq("org_id",source.org_id).eq("data_source_id",source.id).eq("metadata->>source_record_id",current.id);if(docError)throw docError;
        const matches=(m:any)=>Date.parse(m.source_updated_at)===Date.parse(current.updated_at)&&normal(m.call_status)===normal(current.call_status)&&normal(m.ticket_category)===normal(current.ticket_category)&&m.call_outcome===current.call_outcome&&m.call_sequence===current.call_sequence&&Number(m.overall_score)===Number(current.overall_score);
        if(!brainAt&&docs?.length===2&&docs.every(d=>matches(d.metadata))){brainAt=Date.now();state.brainSeconds=(brainAt-Date.parse(current.updated_at))/1000;state.documentIds=docs.map(d=>d.id);save();console.log(JSON.stringify({brainRegistered:true,seconds:state.brainSeconds,documents:2}));}
        if(brainAt&&reportAt&&!state.chatbotSeconds){
          const rows=reportBody.content.split("\n").filter((l:string)=>l.startsWith("|")).map((l:string)=>l.split("|").slice(1,-1).map(s=>s.trim()));const headers=rows.find((r:string[])=>r.some(v=>normal(v)==="currentcrmstatus"));const col=(name:string)=>headers?.findIndex((h:string)=>normal(h)===normal(name));const row=rows.find((r:string[])=>r[col("Prospect")]===label);
          if(!row||normal(row[col("Current CRM Status")])!==(normal(current.call_status)||"pending")||normal(row[col("Original Call Outcome")])!==normal(current.call_outcome)||normal(row[col("Closing Type")])!==(normal(current.ticket_category)||"unclassified"))throw Error("New-call fields do not match in live chatbot");
          state.chatbotSeconds=(reportAt-Date.parse(current.updated_at))/1000;state.pendingNoticeObserved=reportBody.content.includes("still indexing");save();writeFileSync(resolve("../verification/new-call-live-report.md"),reportBody.content);console.log(JSON.stringify({liveChatbotMatched:true,seconds:state.chatbotSeconds}));
        }
        if(state.chatbotSeconds&&docs?.length===2&&docs.every(d=>matches(d.metadata)&&Date.parse(d.metadata.source_body_updated_at)===Date.parse(current.updated_at)&&d.metadata.source_index_state==="ready")){
          const {data:chunks,error:chunkError}=await db.from("chunks").select("id,document_id,metadata,embedding").eq("org_id",source.org_id).eq("data_source_id",source.id).eq("metadata->>source_record_id",current.id).limit(1000);
          if(chunkError)throw chunkError;
          const {data:events}=await db.from("scoring_sync_events").select("id,status,last_error").eq("org_id",source.org_id).eq("data_source_id",source.id).eq("record_id",current.id);
          if(chunks?.length&&chunks.every(c=>matches(c.metadata)&&(Array.isArray(c.embedding)?c.embedding.length>0:typeof c.embedding==="string"&&c.embedding.length>2))&&events?.some(e=>e.status==="completed"&&!e.last_error)){
            fullAt=Date.now();state.phase="complete";state.fullIndexSeconds=(fullAt-Date.parse(current.updated_at))/1000;state.chunks=chunks.length;state.eventIds=events.map(e=>e.id);state.passed=true;save();console.log(JSON.stringify({complete:true,recordId:current.id,brainSeconds:state.brainSeconds,chatbotSeconds:state.chatbotSeconds,fullIndexSeconds:state.fullIndexSeconds,chunks:chunks.length,baselineCalls:baseline,passed:true}));return;
          }
        }
      }
      await new Promise(r=>setTimeout(r,400));
    }
    throw Error("New-call verification timed out; inspect checkpoint and clean up the labeled test call");
  }finally{stop=true;abort.abort();await subscription.catch(()=>{});await auth.auth.signOut({scope:"local"});}
}
main().catch(e=>{console.error(e instanceof Error?e.message:"Verification failed");process.exitCode=1;});
