import { loadEnvConfig } from "@next/env";
import { createServerClient } from "@supabase/ssr";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
loadEnvConfig(process.cwd());
const base = "https://practiscale-rag-chatbot.vercel.app";
async function main() {
  const env = Object.fromEntries(readFileSync(resolve("../practiscale-rag-chatbot/.env.local"), "utf8").split(/\r?\n/).flatMap(line => {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/); return m ? [[m[1], m[2].trim().replace(/^["']|["']$/g, "")]] : [];
  }));
  const cookies = new Map<string, string>();
  const sb = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { cookies: {
    getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: (all: { name: string; value: string }[]) => all.forEach(c => cookies.set(c.name, c.value)),
  } });
  const login = await sb.auth.signInWithPassword({ email: process.env.SETUP_ADMIN_EMAIL!, password: process.env.SETUP_ADMIN_PASSWORD! });
  if (login.error || !login.data.user) throw Error("Admin test sign-in failed");
  const headers = { "content-type": "application/json", cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") };
  async function api(path: string, method = "GET", body?: unknown) {
    const res = await fetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(280_000) });
    const json = await res.json(); if (!res.ok) throw Error(`${path} HTTP ${res.status}: ${json.error ?? "request failed"}`); return json;
  }
  const anonymous = await fetch(base + "/api/creative-history");
  if (anonymous.status !== 401) throw Error("Anonymous history access was not denied");
  const improvement = await api("/api/prompt-improve", "POST", { prompt: "Write a LinkedIn post for NEMT owners about sales follow-up, grounded in PractiScale knowledge, with no invented results." });
  if (typeof improvement.improvedPrompt !== "string" || !Array.isArray(improvement.changes)) throw Error("Invalid prompt improvement");
  console.log(JSON.stringify({ stage: "prompt-improvement", passed: true }));
  let promptId: string | null = null;
  const conversations: string[] = [];
  const results: any[] = [];
  try {
    const layer = await api("/api/prompts", "POST", { title: `[VERIFY] Creative quality ${randomUUID().slice(0, 8)}`, body: "Use a specific opening, plain language and no emojis. Never invent a client, metric or quote." });
    promptId = layer.prompt.id;
    const query = "Write a fresh 180-word LinkedIn post for NEMT owners about improving sales follow-up, grounded in PractiScale knowledge. Use a real case only if supported, otherwise offer practical guidance. Do not invent any result or quote.";
    for (let i = 0; i < 2; i++) {
      const created = await api("/api/conversations", "POST", { tier: "recommended", messages: [{ role: "user", content: `[VERIFY creative upgrade] ${query}` }] });
      const id = created.conversationId; if (!id) throw Error("Test conversation creation failed"); conversations.push(id);
      const res = await fetch(base + "/api/chat", { method: "POST", headers, body: JSON.stringify({ conversationId: id,
        messages: [{ role: "user", content: query }], mode: "general", timeZone: "Asia/Karachi",
        creative: { audience: "NEMT business owners", goal: "Improve follow-up discipline", targetWords: 180, angle: i ? "diagnostic" : "practical", promptIds: [promptId], memoryScope: "account", freshness: "fresh" } }), signal: AbortSignal.timeout(280_000) });
      const stream = await res.text(); let answer = ""; const events: any[] = []; const errors: unknown[] = [];
      for (const line of stream.split("\n")) { try { const data = JSON.parse(line.slice(2)); if (line.startsWith("0:")) answer += data; if (line.startsWith("2:")) events.push(...data); if (line.startsWith("3:")) errors.push(data); } catch { /* stream frames */ } }
      const receipt = events.find(e => e.type === "generation_receipt");
      const result = { turn: i + 1, http: res.status, model: res.headers.get("x-model"), receipt, answer, errors,
        passed: res.ok && errors.length === 0 && answer.length > 200 && receipt?.creative === true && receipt?.layers?.includes(layer.prompt.title) && receipt?.targetWords === 180 && (i === 0 || receipt?.draftsCompared > 0) && (receipt?.overlapPercent ?? 0) < 55 };
      results.push(result); console.log(JSON.stringify({ ...result, answer: undefined }));
      // Wait for the authorized transient turn to be saved, proving the next
      // separate chat can see it through the caller's OWN persisted history.
      let saved = false;
      for (let poll = 0; poll < 15; poll++) {
        const { data } = await sb.from("messages").select("id").eq("user_id", login.data.user.id).eq("conversation_id", id).eq("role", "assistant").limit(1);
        if (data?.length) { saved = true; break; }
        await new Promise(r => setTimeout(r, 1000));
      }
      if (!saved) throw Error("Test answer was not persisted for cross-chat history verification");
    }
    const ledger = await api("/api/creative-history");
    if (!ledger.drafts.some((d: any) => conversations.includes(d.conversation_id))) throw Error("Saved draft missing from account ledger");
    const dir = resolve("../verification"); mkdirSync(dir, { recursive: true });
    const report = resolve(dir, `creative-upgrade-${Date.now()}.json`);
    writeFileSync(report, JSON.stringify({ checkedAt: new Date().toISOString(), anonymousDenied: true, improvement, results }, null, 2));
    console.log(JSON.stringify({ report, passed: results.every(r => r.passed) }));
    if (results.some(r => !r.passed)) process.exitCode = 1;
  } finally {
    for (const id of conversations) await api(`/api/conversations?id=${id}`, "DELETE");
    if (promptId) await api(`/api/prompts?id=${promptId}`, "DELETE");
    console.log(JSON.stringify({ cleanedTestConversations: conversations.length, cleanedTestPrompt: !!promptId }));
  }
}
main().catch(e => { console.error(e instanceof Error ? e.message : "Creative verification failed"); process.exitCode = 1; });
