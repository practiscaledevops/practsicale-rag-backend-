// Small, budgeted end-to-end checks through the authenticated production spoke.
// Unlike the 10,080 contract fixtures, these exercise live retrieval and routing.
import {loadEnvConfig} from "@next/env";
import {createServerClient} from "@supabase/ssr";
import {readFileSync,writeFileSync,appendFileSync,existsSync,mkdirSync} from "node:fs";
import {resolve} from "node:path";
import {costUsd} from "../src/lib/pricing";
loadEnvConfig(process.cwd());
const cases:Record<string,string>={
 general:"Summarize PractiScale's documented services and what you cannot confirm about current terms.",
 ceo_advisor:"Recommend one CEO priority from the available operating evidence. Separate evidence from your proposal.",
 strategy_advisor:"Compare improving fulfillment with acquiring more leads as proposed strategic options. Identify one fact to verify before deciding.",
 sales_coach:"Give a proposed response to a prospect saying 'I need to think about it', using our documented sales approach. Do not invent a past conversation.",
 marketing_advisor:"Propose one measurable marketing experiment for PractiScale. Do not assume an existing campaign or promise revenue.",
 offer_architect:"Propose one improvement to how we explain offer value. Do not invent a current price or guarantee.",
 cs_advisor:"Propose an onboarding improvement grounded in the available service evidence. Separate current policy from your suggestion.",
 management_coach:"Give a proposed delegation agreement for a team lead. Use role placeholders where actual ownership is not documented.",
 hiring_advisor:"Propose three job-related interview questions for an operations role and one scoring rule. Do not assess a real candidate.",
 operations_advisor:"Propose a quality-control checkpoint for fulfillment, with a trigger, owner role, and acceptance criterion.",
 content_strategist:"Propose three distinct educational content angles using documented company knowledge. Avoid fabricated client results.",
 copywriter:"Write two distinct short ad hooks based on our documented services. Do not invent testimonials, scarcity, prices or results.",
 ceo_content:"Draft a short founder post from verified company experience only. If no founder experience is supplied, give a clearly proposed outline instead of inventing a story.",
 distribution_strategist:"Propose a two-channel distribution experiment with a success measure. Do not assert current algorithm rules.",
 training_builder:"Build a short training outline on reliable client handoffs with a learning objective, exercise and assessment. Label it as proposed.",
 sop_builder:"Draft a proposed five-step handoff SOP with owner placeholders and an exception path.",
 decision_memo:"Write a short decision memo on a proposed fulfillment QA checkpoint: evidence, options, recommendation and missing inputs.",
 research_analyst:"Explain the difference between a call's original outcome, current CRM status, ticket classification, call date and outcome date. Do not count records from a retrieval sample.",
};
async function main(){
 const env=Object.fromEntries(readFileSync(resolve("../practiscale-rag-chatbot/.env.local"),"utf8").split(/\r?\n/).flatMap(line=>{const m=line.match(/^([A-Z_0-9]+)=(.*)$/);return m?[[m[1],m[2].trim().replace(/^["']|["']$/g,"")]]:[];}));
 const cookies=new Map<string,string>();
 const auth=createServerClient(env.NEXT_PUBLIC_SUPABASE_URL,env.NEXT_PUBLIC_SUPABASE_ANON_KEY,{cookies:{getAll:()=>[...cookies].map(([name,value])=>({name,value})),setAll:(all:{name:string;value:string}[])=>all.forEach(c=>cookies.set(c.name,c.value))}});
 const login=await auth.auth.signInWithPassword({email:process.env.SETUP_ADMIN_EMAIL!,password:process.env.SETUP_ADMIN_PASSWORD!});
 if(login.error||(await auth.auth.getUser()).error)throw Error("Chatbot sign-in failed");
 const root=resolve("../verification/mode-audit-2026-11-12");mkdirSync(root,{recursive:true});
 const run=(process.argv.find(a=>a.startsWith("--run="))?.slice(6)??"live-modes").replace(/[^\w-]/g,"_");
 const output=resolve(root,`${run}.jsonl`);
 const previous=existsSync(output)?readFileSync(output,"utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l)):[];
 const done=new Set(previous.map(r=>r.mode));
 let reserved=previous.reduce((n,r)=>n+r.budgetDebitUsd,0);
 const only=process.argv.find(a=>a.startsWith("--only="))?.slice(7);
 const cap=Number(process.argv.find(a=>a.startsWith("--cap="))?.slice(6)??"1.60");
 if(!Number.isFinite(cap)||cap<=0||cap>1.60)throw Error("Invalid live audit cap");
 for(const [mode,task] of Object.entries(cases)){
  if(only&&mode!==only)continue;
  if(done.has(mode))continue;
  // Includes a conservative allowance for rewriting, routing and verification
  // not exposed in the spoke's generation-token receipt. Never call this exact billing.
  if(reserved+0.20>cap)break;
  const started=Date.now();
  const prompt=task+" Keep the entire answer within 120 words. This is a concise quality check, not a request for a full course or long report.";
  const response=await fetch("https://practiscale-rag-chatbot.vercel.app/api/chat",{method:"POST",headers:{"content-type":"application/json",cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join("; ")},body:JSON.stringify({messages:[{role:"user",content:prompt,createdAt:new Date().toISOString()}],mode,model:"recommended",timeZone:"Asia/Karachi"}),signal:AbortSignal.timeout(275000)});
  let answer="",usage:any=null;const events:any[]=[],errors:unknown[]=[];
  const raw=await response.text();
  for(const line of raw.split("\n")){try{const value=JSON.parse(line.slice(2));if(line.startsWith("0:"))answer+=value;if(line.startsWith("2:")&&Array.isArray(value))events.push(...value);if(line.startsWith("3:"))errors.push(value);if(line.startsWith("d:")||line.startsWith("e:"))usage=value.usage??usage;}catch{}}
  const receipt=events.find(e=>e.type==="generation_receipt");
  const mainCost=usage?costUsd(receipt?.model??"gpt-6.1-sol",usage.promptTokens??0,usage.completionTokens??0):0.10;
  // The faithfulness model also reads the evidence. Include its actual usage
  // when available; older deployments need a conservative equivalent-context
  // allowance. Rewriting/intent/reranking use the fast model and small prompts.
  const verificationCost=receipt?.verificationUsage?.estimatedCostUsd??
   (usage?costUsd("gpt-6.1-sol",(usage.promptTokens??0)+4096,2350):0);
  const debit=mainCost+verificationCost+0.01;reserved+=debit;
  const checks={http:response.ok,answer:answer.trim().length>40,streamErrors:errors.length===0,correctMode:receipt?.mode===mode,citations:receipt?.invalidCitations===0,verified:receipt?.faithfulness==="Checked against supplied evidence",notWithheld:!/(?:I couldn't verify the generated answer|verification step is temporarily unavailable)/i.test(answer)};
  const row={mode,prompt,answer,checks,passed:Object.values(checks).every(Boolean),receipt,errors,usage,estimatedGenerationCostUsd:mainCost,estimatedVerificationCostUsd:verificationCost,budgetDebitUsd:debit,latencyMs:Date.now()-started};
  appendFileSync(output,JSON.stringify(row)+"\n");previous.push(row);
  console.log(JSON.stringify({mode,passed:row.passed,checks,latencyMs:row.latencyMs,budgetDebitUsd:reserved}));
  if(!row.passed)break;
 }
 writeFileSync(resolve(root,`${run}-summary.json`),JSON.stringify({kind:"live_app_requests",completed:previous.length,passed:previous.filter(r=>r.passed).length,failed:previous.filter(r=>!r.passed).length,budgetDebitUsd:reserved},null,2));
}
main().catch(e=>{console.error(e.name);process.exitCode=1;});
