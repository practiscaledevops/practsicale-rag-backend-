// Live, opt-in verification. Secrets and source contents are never printed.
// Run from this repo: npx tsx scripts/verify-local.ts
// Both apps must be running (Brain :3010, chatbot :3011), with the chatbot repo
// beside this one. Uses the existing SETUP_ADMIN_EMAIL/PASSWORD for sign-in.
// Default: Supabase/schema/key checks and tiny direct model/embedding requests.
// --synthetic: fixed greetings through every configured tier; no retrieval.
// --chat: REAL company retrieval through Claude and GPT, token/cost records,
//         save/reload, then deletion of ONLY this run's new test conversation.
// --attachments: synthetic text/PDF extraction; files are not stored.
// --dashboard: authenticated Brain dashboard and admin API reads.
// --validation: verify authentication and malformed-request rejection.
// Chat requests produce the usual persistent usage/audit events in both apps.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());
function readEnv(path: string): Record<string, string> {
  return Object.fromEntries(readFileSync(path, "utf8").split(/\r?\n/).flatMap((line) => {
    const m = line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);
    return m ? [[m[1], m[2].trim().replace(/^["']|["']$/g, "")]] : [];
  }));
}
const chatbotEnv = readEnv(resolve("../practiscale-rag-chatbot/.env.local"));
const secrets = [...Object.entries(process.env), ...Object.entries(chatbotEnv)]
  .filter(([name, value]) => /KEY|SECRET|PASSWORD/.test(name) && value && value.length > 8)
  .map(([, value]) => value!);
function report(name: string, detail: unknown) {
  const failed = (v: any): boolean => v === false || (Array.isArray(v) ? v.some(failed) : !!v && typeof v === "object" &&
    (!!v.error || v.ok === false || (typeof v.status === "number" && v.status >= 400) || v.errors?.length > 0));
  if (failed(detail)) process.exitCode = 1;
  let line = JSON.stringify({ check: name, detail });
  for (const secret of secrets) line = line.split(secret).join("[redacted]");
  console.log(line);
}
const timedFetch: typeof fetch = (input, init) => fetch(input, {
  ...init, signal: init?.signal ?? AbortSignal.timeout(30_000),
});
const brain = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false }, global: { fetch: timedFetch },
});
const chatbot = createClient(chatbotEnv.NEXT_PUBLIC_SUPABASE_URL, chatbotEnv.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }, global: { fetch: timedFetch },
});
async function verifyChatFlow() {
  const cookies = new Map<string, string>();
  const auth = createServerClient(chatbotEnv.NEXT_PUBLIC_SUPABASE_URL, chatbotEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
      setAll: (all: { name: string; value: string }[]) => { for (const cookie of all) cookies.set(cookie.name, cookie.value); } },
    global: { fetch: timedFetch },
  });
  const { data, error } = await auth.auth.signInWithPassword({
    email: process.env.SETUP_ADMIN_EMAIL!, password: process.env.SETUP_ADMIN_PASSWORD!,
  });
  if (error || !data.user) throw new Error(`Chatbot login failed: ${error?.message}`);
  const verifiedSession = await auth.auth.getUser();
  if (verifiedSession.error || !verifiedSession.data.user) throw new Error("Chatbot session verification failed");
  const userId = data.user.id;
  const headers = { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "), "content-type": "application/json" };
  const base = (process.env.VERIFY_CHATBOT_URL ?? "http://localhost:3011").replace(/\/$/, "");
  for (const path of ["/", "/api/models", "/api/collections", "/api/chat-limits", "/api/conversations"]) {
    const res = await timedFetch(`${base}${path}`, { headers, redirect: "manual" });
    await res.arrayBuffer();
    report(`authenticated${path}`, { status: res.status, redirect: res.headers.get("location") });
    if (!res.ok) throw new Error(`Authenticated route ${path} returned ${res.status}`);
  }
  if (process.argv.includes("--attachments")) {
    const fixture = "Local verification fixture: attachment extraction works.";
    for (const [name, blob] of [["verification.txt", new Blob([fixture], { type: "text/plain" })],
      ["verification.pdf", new Blob([new Uint8Array(readFileSync("test/fixtures/text.pdf"))], { type: "application/pdf" })]] as const) {
      const form = new FormData();
      form.append("file", blob, name);
      const res = await fetch(`${base}/api/attachments`, { method: "POST", headers: { cookie: headers.cookie }, body: form, signal: AbortSignal.timeout(120_000) });
      const json = await res.json();
      report(`attachment-${name}`, { status: res.status, kind: json.kind, containsFixture: json.text?.includes(fixture), error: json.error });
      if (!res.ok || !json.text?.includes(fixture)) throw new Error(`${name} extraction failed`);
    }
    return;
  }
  if (process.argv.includes("--dashboard")) {
    const jar = new Map<string, string>();
    const admin = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: (all: { name: string; value: string }[]) => { for (const cookie of all) jar.set(cookie.name, cookie.value); } },
      global: { fetch: timedFetch },
    });
    const { error: signInError } = await admin.auth.signInWithPassword({ email: process.env.SETUP_ADMIN_EMAIL!, password: process.env.SETUP_ADMIN_PASSWORD! });
    if (signInError) throw new Error(`Brain dashboard login failed: ${signInError.message}`);
    const verified = await admin.auth.getUser();
    report("brain-session", { verified: !!verified.data.user, cookieCount: jar.size, error: verified.error?.message });
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    for (const path of ["/dashboard", "/api/admin/providers", "/api/admin/knowledge/overview", "/api/admin/documents"]) {
      const res = await fetch(`http://localhost:3010${path}`, { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(60_000) });
      await res.arrayBuffer();
      report(`brain-authenticated${path}`, { status: res.status, redirect: res.headers.get("location") });
      if (!res.ok) process.exitCode = 1;
    }
    return;
  }
  if (process.argv.includes("--validation")) {
    const keyHeaders = { authorization: `Bearer ${chatbotEnv.BRAIN_API_KEY}`, "content-type": "application/json" };
    const checks = [
      { path: "http://localhost:3011/api/chat", headers: {}, body: "{}", expected: 401 },
      { path: "http://localhost:3010/api/v1/chat", headers: {}, body: "{}", expected: 401 },
      { path: "http://localhost:3011/api/chat", headers, body: "{", expected: 400 },
      { path: "http://localhost:3010/api/v1/chat", headers: keyHeaders, body: "{", expected: 400 },
      { path: "http://localhost:3010/api/v1/retrieve", headers: keyHeaders, body: "{", expected: 400 },
    ];
    for (const check of checks) {
      const res = await timedFetch(check.path, { method: "POST", headers: check.headers, body: check.body });
      await res.arrayBuffer();
      report("request-validation", { route: check.path, actual: res.status, expected: check.expected, ok: res.status === check.expected });
    }
    return;
  }
  if (process.argv.includes("--synthetic")) {
    // The greeting fast path uses a fixed public system prompt and skips ALL
    // retrieval. No company source content, project files or saved chat is sent.
    for (const model of ["fast", "recommended", "max", "gpt-4o-mini"]) {
      const res = await fetch(`${base}/api/chat`, { method: "POST", headers,
        body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }], model, mode: "general" }),
        signal: AbortSignal.timeout(120_000) });
      const stream = await res.text();
      const lines = stream.split("\n");
      const answer = lines.filter((line) => line.startsWith("0:")).map((line) => JSON.parse(line.slice(2))).join("");
      const errors = lines.filter((line) => line.startsWith("3:")).map((line) => JSON.parse(line.slice(2)));
      const finish = lines.filter((line) => line.startsWith("d:")).map((line) => JSON.parse(line.slice(2))).at(-1);
      report(`synthetic-chat-${model}`, { status: res.status, answerChars: answer.length, usage: finish?.usage, errors });
      if (!res.ok || !answer || errors.length || !(finish?.usage?.promptTokens > 0) || !(finish?.usage?.completionTokens > 0)) throw new Error(`Synthetic ${model} stream or usage failed`);
    }
    return;
  }
  const question = "What is PractiScale? Give a short answer in two bullets using the Brain's company knowledge, with citations.";
  const create = await timedFetch(`${base}/api/conversations`, { method: "POST", headers,
    body: JSON.stringify({ title: "[Local verification] Brain integration", tier: "fast" }) });
  const created = await create.json();
  if (!create.ok || !created.conversationId) throw new Error(`Conversation creation failed: ${JSON.stringify(created)}`);
  const id = created.conversationId;
  report("conversation-create", { status: create.status });
  try {
    const startedAt = new Date().toISOString();
    for (const model of ["fast", "gpt-4o-mini"]) {
      const start = Date.now();
      const res = await fetch(`${base}/api/chat`, { method: "POST", headers,
        body: JSON.stringify({ conversationId: id, messages: [{ role: "user", content: question }], model, mode: "general", timeZone: "Asia/Karachi" }),
        signal: AbortSignal.timeout(300_000) });
      const stream = await res.text();
      let answer = "";
      const events: any[] = [];
      const errors: unknown[] = [];
      let usage: unknown;
      for (const line of stream.split("\n")) {
        try {
          const value = JSON.parse(line.slice(2));
          if (line.startsWith("0:")) answer += value;
          if (line.startsWith("2:") && Array.isArray(value)) events.push(...value);
          if (line.startsWith("3:")) errors.push(value);
          if (line.startsWith("d:")) usage = value.usage;
        } catch { /* non-stream errors checked below */ }
      }
      const sources = events.find((e) => e.type === "sources")?.sources ?? [];
      report(`chat-${model}`, { status: res.status, durationMs: Date.now() - start, answerChars: answer.length,
        sources: sources.length, cited: /\[[^\]\s]+\]/.test(answer), stages: events.filter((e) => e.type === "status").map((e) => e.stage), usage, errors,
        ...(res.ok ? {} : { error: stream.slice(0, 500) }) });
      const tokens = usage as { promptTokens?: number; completionTokens?: number } | undefined;
      if (!res.ok || errors.length || !answer || !sources.length || !(tokens?.promptTokens! > 0) || !(tokens?.completionTokens! > 0)) throw new Error(`Grounded ${model} chat or usage failed`);
      let saved = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        const { data: messages } = await chatbot.from("messages").select("role,content").eq("conversation_id", id).eq("user_id", userId);
        saved = !!messages?.some((m) => m.role === "assistant" && m.content === answer);
        if (saved) break;
        await new Promise((done) => setTimeout(done, 1000));
      }
      report(`chat-${model}-server-save`, { ok: saved });
      if (!saved) throw new Error("Server-side conversation persistence did not finish");
    }
    const { count, error: usageError } = await chatbot.from("usage_events").select("id", { count: "exact", head: true })
      .eq("user_id", userId).eq("conversation_id", id).gte("created_at", startedAt);
    report("chatbot-usage-metering", { count, error: usageError?.message });
    if (usageError || count !== 2) throw new Error("Expected two metered chatbot turns");
    const { data: metered, error: meteredError } = await chatbot.from("usage_events")
      .select("provider,input_tokens,output_tokens,cost_usd").eq("conversation_id", id).eq("user_id", userId);
    report("chatbot-usage-values", { rows: metered, error: meteredError?.message });
    if (meteredError || !metered?.every((row) => row.input_tokens > 0 && row.output_tokens > 0 && row.cost_usd > 0)) throw new Error("Metered token/cost values are missing");
    const { data: brainUsage, error: brainUsageError } = await brain.from("usage_events").select("model,input_tokens,output_tokens,cost_usd")
      .gte("created_at", startedAt).in("model", [process.env.FAST_CHAT_MODEL ?? "claude-haiku-4-5", "gpt-4o-mini"]);
    report("brain-usage-values", { rows: brainUsage, error: brainUsageError?.message });
    if (brainUsageError || !brainUsage || brainUsage.length < 2 || !brainUsage.every((row) => row.input_tokens > 0 && row.output_tokens > 0 && row.cost_usd > 0)) throw new Error("Brain token/cost records are missing");
    const savedPage = await timedFetch(`${base}/c/${id}`, { headers });
    const html = await savedPage.text();
    report("conversation-reload", { status: savedPage.status, containsQuestion: html.includes("What is PractiScale?") });
    if (!savedPage.ok || !html.includes("What is PractiScale?")) throw new Error("Saved conversation could not reload");
  } finally {
    // Delete only this run's new conversation through its normal owner-scoped API.
    const cleanup = await timedFetch(`${base}/api/conversations`, { method: "DELETE", headers, body: JSON.stringify({ id }) });
    report("test-conversation-cleanup", { status: cleanup.status });
    if (!cleanup.ok) throw new Error("Could not remove this run's test conversation");
    const { data: remaining, error: cleanupError } = await chatbot.from("conversations").select("id").eq("id", id).eq("user_id", userId).maybeSingle();
    report("test-conversation-removed", { ok: !remaining && !cleanupError, error: cleanupError?.message });
  }
}
async function main() {
  if (["--chat", "--synthetic", "--attachments", "--dashboard", "--validation"].some((flag) => process.argv.includes(flag))) return verifyChatFlow();
  report("separate-databases", process.env.NEXT_PUBLIC_SUPABASE_URL !== chatbotEnv.NEXT_PUBLIC_SUPABASE_URL);
  for (const [label, db, tables] of [
    ["brain", brain, ["orgs", "org_members", "documents", "chunks", "knowledge_objects", "provider_secrets", "knowledge_submissions", "jobs"]],
    ["chatbot", chatbot, ["profiles", "conversations", "messages", "teams", "usage_events", "app_settings", "project_files"]],
  ] as const) {
    const results = await Promise.all(tables.map(async (table) => {
      const { error, count } = await db.from(table).select("*", { count: "estimated", head: true });
      return { table, ok: !error, count, ...(error ? { code: error.code, error: error.message } : {}) };
    }));
    report(`${label}-supabase`, results);
  }
  const hash = createHash("sha256").update(chatbotEnv.BRAIN_API_KEY).digest("hex");
  const { data: key, error: keyError } = await brain.from("api_keys")
    .select("id,org_id,capabilities,source_types,expires_at,revoked_at").eq("key_hash", hash).maybeSingle();
  report("scoped-key", { ok: !!key && !key.revoked_at && (!key.expires_at || Date.parse(key.expires_at) > Date.now()), found: !!key, capabilities: key?.capabilities, sourceTypes: key?.source_types,
    revoked: !!key?.revoked_at, expired: !!key?.expires_at && Date.parse(key.expires_at) < Date.now(), error: keyError?.message });

  for (const [label, url] of [["brain", "http://localhost:3010/login"], ["chatbot", "http://localhost:3011/login"]]) {
    try { const res = await timedFetch(url); const text = await res.text();
      report(`${label}-login`, { status: res.status, html: text.includes("<html"), serverError: text.includes("Internal Server Error") });
    } catch (e) { report(`${label}-login`, { error: String(e) }); }
  }
  for (const path of ["models", "capabilities", "collections"]) {
    try {
      const res = await timedFetch(`http://localhost:3010/api/v1/${path}`, { headers: { authorization: `Bearer ${chatbotEnv.BRAIN_API_KEY}` } });
      const json = await res.json();
      report(`brain-${path}`, { status: res.status, count: json.models?.length ?? json.capabilities?.length ?? json.collections?.length,
        error: json.error, ...(json.models ? { models: json.models.map((m: any) => ({ id: m.id, status: m.availability?.status })) } : {}) });
    } catch (e) { report(`brain-${path}`, { error: String(e) }); }
  }
  const { getProviderKey } = await import("../src/lib/secrets");
  const openaiKey = await getProviderKey("openai");
  const anthropicKey = await getProviderKey("anthropic");
  if (openaiKey) secrets.push(openaiKey);
  if (anthropicKey) secrets.push(anthropicKey);
  for (const [label, url, key, body, extraHeaders] of [
    ["openai-embeddings", "https://api.openai.com/v1/embeddings", openaiKey,
      { model: process.env.EMBEDDING_MODEL ?? "text-embedding-3-large", dimensions: 1024, input: "Local integration verification" }, {}],
    ["openai-generation", "https://api.openai.com/v1/chat/completions", openaiKey,
      { model: "gpt-4o-mini", messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 8 }, {}],
    ["anthropic-generation", "https://api.anthropic.com/v1/messages", anthropicKey,
      { model: process.env.FAST_CHAT_MODEL ?? "claude-haiku-4-5", messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 8 }, { "anthropic-version": "2023-06-01" }],
  ] as const) {
    if (!key) { report(label, { error: "No configured key" }); continue; }
    try {
      const res = await timedFetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...(label.startsWith("anthropic") ? { "x-api-key": key } : {}), ...extraHeaders }, body: JSON.stringify(body) });
      const json = await res.json();
      report(label, { status: res.status, model: json.model, dimensions: json.data?.[0]?.embedding?.length,
        generated: !!(json.choices?.[0]?.message?.content || json.content?.[0]?.text), error: json.error?.message ?? json.error });
    } catch (e) { report(label, { error: String(e) }); }
  }
  const { error: authError } = await chatbot.auth.signInWithPassword({
    email: process.env.SETUP_ADMIN_EMAIL!, password: process.env.SETUP_ADMIN_PASSWORD!,
  });
  report("chatbot-existing-admin-login", { ok: !authError, error: authError?.message });
}
main().catch((e) => { report("fatal", { error: String(e) }); process.exitCode = 1; });
