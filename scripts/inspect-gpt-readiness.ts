import { loadEnvConfig } from "@next/env";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
loadEnvConfig(process.cwd());

async function main() {
  const { getProviderKey } = await import("../src/lib/secrets");
  const { supabaseAdmin } = await import("../src/lib/supabase");
  const db = supabaseAdmin();
  const { data: source, error } = await db.from("data_sources").select("org_id").eq("slug", "call-scoring").single();
  if (error) throw Error(error.message);
  const snapshots: Record<string, unknown> = {};
  for (const table of ["prompts", "app_settings"]) {
    const result = await db.from(table).select("*").eq("org_id", source.org_id);
    if (result.error) throw Error(result.error.message);
    snapshots[table] = result.data;
  }
  const directory = resolve("../verification"); mkdirSync(directory, { recursive: true });
  const backup = resolve(directory, `pre-gpt-settings-${Date.now()}.json`);
  writeFileSync(backup, JSON.stringify(snapshots, null, 2));
  console.log(JSON.stringify({ orgId: source.org_id, backup, settings: snapshots.app_settings,
    prompts: (snapshots.prompts as any[]).filter(p => p.is_active).map(p => ({ useCase: p.use_case, version: p.version, chars: p.content.length })) }));
  const apiKey = await getProviderKey("openai");
  if (!apiKey) throw Error("OpenAI key is not configured");
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
  const list = await fetch("https://api.openai.com/v1/models", { headers, signal: AbortSignal.timeout(30_000) });
  if (!list.ok) throw Error(`OpenAI model catalog HTTP ${list.status}`);
  const ids = ((await list.json()).data as { id: string }[]).map(m => m.id).filter(id => /^gpt-6/.test(id));
  console.log(JSON.stringify({ accountModels: ids }));
  for (const model of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers,
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly OK." }], reasoning_effort: "low", max_completion_tokens: 1024 }), signal: AbortSignal.timeout(90_000) });
    const body = await res.json();
    console.log(JSON.stringify({ model, http: res.status, returnedModel: body.model, text: body.choices?.[0]?.message?.content, usage: body.usage, errorCode: body.error?.code, errorType: body.error?.type }));
    if (!res.ok || !body.choices?.[0]?.message?.content) process.exitCode = 1;
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
