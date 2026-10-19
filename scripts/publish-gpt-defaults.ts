// Publish tested code defaults as new Prompt Studio versions; retain history.
// Dry run by default. Apply explicitly with: npx tsx scripts/publish-gpt-defaults.ts --apply
import { loadEnvConfig } from "@next/env";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
loadEnvConfig(process.cwd());

async function main() {
  const { supabaseAdmin } = await import("../src/lib/supabase");
  const { PROMPT_USE_CASES } = await import("../src/lib/prompts");
  const { loadSettings, saveSettings } = await import("../src/lib/settings");
  const db = supabaseAdmin();
  const { data: source, error: sourceError } = await db.from("data_sources").select("org_id").eq("slug", "call-scoring").single();
  if (sourceError) throw Error(sourceError.message);
  const orgId = source.org_id as string;
  const { data: previous, error } = await db.from("prompts").select("*").eq("org_id", orgId).order("version", { ascending: false });
  if (error) throw Error(error.message);
  const { settings: before } = await loadSettings(orgId, db);
  const env = Object.fromEntries(readFileSync(resolve("../practiscale-rag-chatbot/.env.local"), "utf8").split(/\r?\n/).flatMap(line => {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/); return m ? [[m[1], m[2].trim().replace(/^["']|["']$/g, "")]] : [];
  }));
  const chatbot = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: chatbotBefore, error: chatbotError } = await chatbot.from("app_settings").select("*").eq("id", 1).maybeSingle();
  if (chatbotError) throw Error(chatbotError.message);
  const planned = PROMPT_USE_CASES.map(p => ({ key: p.key, chars: p.default.length,
    unchanged: previous?.some(row => row.use_case === p.key && row.is_active && row.content === p.default) }));
  console.log(JSON.stringify({ orgId, apply: process.argv.includes("--apply"), prompts: planned, defaultModel: "gpt-6.1-sol", fastModel: "gpt-6-luna" }));
  if (!process.argv.includes("--apply")) return;
  const directory = resolve("../verification"); mkdirSync(directory, { recursive: true });
  const backup = resolve(directory, `gpt-rollout-backup-${Date.now()}.json`);
  writeFileSync(backup, JSON.stringify({ orgId, prompts: previous, settings: before, chatbotSettings: chatbotBefore }, null, 2));
  const activated: string[] = [];
  try {
    for (const uc of PROMPT_USE_CASES) {
      if (planned.find(p => p.key === uc.key)?.unchanged) continue;
      const version = Math.max(0, ...(previous ?? []).filter(p => p.use_case === uc.key).map(p => p.version)) + 1;
      const { data: created, error: insertError } = await db.from("prompts").insert({ org_id: orgId, use_case: uc.key, version, content: uc.default, is_active: false }).select("id").single();
      if (insertError) throw Error(insertError.message);
      const off = await db.from("prompts").update({ is_active: false }).eq("org_id", orgId).eq("use_case", uc.key).eq("is_active", true);
      if (off.error) throw Error(off.error.message);
      activated.push(uc.key); // roll back even if activation below fails
      const on = await db.from("prompts").update({ is_active: true }).eq("org_id", orgId).eq("id", created.id);
      if (on.error) throw Error(on.error.message);
      console.log(JSON.stringify({ useCase: uc.key, version, active: true }));
    }
    await saveSettings(orgId, { ...before,
      features: { ...before.features, groundOrRefuse: true, faithfulnessCheck: true },
      generation: { ...before.generation, defaultTier: "recommended", maxTokens: 4096, temperature: 0 },
      contextual: { ...before.contextual, tier: "fast" },
      intelligence: { ...before.intelligence, classifyTier: "recommended", compileTier: "recommended", intentTier: "fast" },
    }, null, db);
    const saved = await chatbot.from("app_settings").upsert({ id: 1,
      data: { ...(chatbotBefore?.data ?? {}), defaultModel: "gpt-6.1-sol", defaultModelKind: "model", ragDefaultOn: true }, updated_at: new Date().toISOString() });
    if (saved.error) throw Error(saved.error.message);
    const { data: active, error: readError } = await db.from("prompts").select("use_case,version,content").eq("org_id", orgId).eq("is_active", true);
    if (readError || PROMPT_USE_CASES.some(p => active?.filter(a => a.use_case === p.key && a.content === p.default).length !== 1)) throw Error("Published prompt readback did not match defaults");
    const { data: readback, error: readbackError } = await chatbot.from("app_settings").select("data").eq("id", 1).single();
    if (readbackError || readback.data.defaultModel !== "gpt-6.1-sol") throw Error("Chatbot default readback failed");
    console.log(JSON.stringify({ published: true, prompts: active?.map(p => ({ key: p.use_case, version: p.version })), backup }));
  } catch (e) {
    // Preserve the previous live versions/settings if any stage fails.
    const failures: string[] = [];
    for (const key of activated) {
      const off = await db.from("prompts").update({ is_active: false }).eq("org_id", orgId).eq("use_case", key);
      if (off.error) failures.push(key);
      for (const row of (previous ?? []).filter(p => p.use_case === key && p.is_active)) {
        const on = await db.from("prompts").update({ is_active: true }).eq("org_id", orgId).eq("id", row.id);
        if (on.error) failures.push(key);
      }
    }
    try { await saveSettings(orgId, before, null, db); } catch { failures.push("brain_settings"); }
    if (chatbotBefore) { const restored = await chatbot.from("app_settings").upsert(chatbotBefore); if (restored.error) failures.push("chatbot_settings"); }
    throw Error(`${e instanceof Error ? e.message : "Publication failed"}; rollback ${failures.length ? `needs attention: ${failures.join(",")}` : "completed"}; backup: ${backup}`);
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
