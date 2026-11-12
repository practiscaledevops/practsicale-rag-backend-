import {loadEnvConfig} from "@next/env";
import {writeFileSync} from "node:fs";
import {resolve} from "node:path";
loadEnvConfig(process.cwd());
async function main(){
 const {supabaseAdmin}=await import("../src/lib/supabase");
 const {loadSettings}=await import("../src/lib/settings");
 const {runOrchestratedRetrieval}=await import("../src/lib/orchestrator");
 const db=supabaseAdmin();const {data:s,error}=await db.from("data_sources").select("org_id").eq("slug","call-scoring").single();if(error)throw error;
 const {settings}=await loadSettings(s.org_id);
 const query="Summarize PractiScale's documented services and what you cannot confirm about current terms. Keep the entire answer within 120 words. This is a concise quality check, not a request for a full course or long report.";
 const started=Date.now();
 const result=await runOrchestratedRetrieval({orgId:s.org_id,query,history:[],scope:{sourceTypes:[],dataSourceIds:[],collectionIds:[]},settings,requestedMode:"general",timeZone:"Asia/Karachi"});
 const ok=!result.callReview&&result.chunks.length<=settings.retrieval.rerankTopN&&result.contextBlock.length<60000;
 console.log(JSON.stringify({ok,mode:result.mode,chunks:result.chunks.length,contextChars:result.contextBlock.length,callReview:!!result.callReview,ms:Date.now()-started}));
 if(!ok)process.exitCode=1;
 if(ok&&process.argv.includes("--answer")){
  const {generateText}=await import("ai");
  const {getModel}=await import("../src/lib/llm");
  const {generationParams}=await import("../src/lib/models-catalog");
  const {getActivePrompt}=await import("../src/lib/prompts-db");
  const {modeInstruction}=await import("../src/lib/prompts");
  const {REASONING_ORDER_INSTRUCTION}=await import("../src/lib/work-modes");
  const {checkFaithfulness}=await import("../src/lib/faithfulness");
  const {costUsd}=await import("../src/lib/pricing");
  const policy=await getActivePrompt(s.org_id,"chat");
  const model=await getModel("recommended");
  const answer=await generateText({model,system:`${policy}\n\n${modeInstruction("general")}\n\n${REASONING_ORDER_INSTRUCTION}\n\nContext:\n${result.contextBlock}`,prompt:query,...generationParams(model.modelId,{maxTokens:500}),maxRetries:0,abortSignal:AbortSignal.timeout(60000)});
  const verdict=await checkFaithfulness(result.contextBlock,answer.text,await getActivePrompt(s.org_id,"faithfulness"),"recommended",AbortSignal.timeout(45000),{question:query,trustedPolicy:policy});
  const row={kind:"live_retrieval_diagnostic",query,answer:answer.text,verdict,usage:answer.usage,estimatedCostUsd:costUsd(model.modelId,answer.usage.promptTokens,answer.usage.completionTokens)+(verdict.usage?.estimatedCostUsd??0)+0.01};
  writeFileSync(resolve("../verification/mode-audit-2026-11-12/context-diagnostic.json"),JSON.stringify(row,null,2));
  console.log(JSON.stringify(row));
 }
}
main().catch(e=>{console.error(e.name??"Context probe failed");process.exitCode=1;});
