// Live, opt-in company-data checks through the configured model providers.
// Covers every status/ticket combination present in the source with both Claude
// and OpenAI. Chats are transient; reports contain only IDs and classifications.
import { loadEnvConfig } from "@next/env";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
loadEnvConfig(process.cwd());
// A grounded model may put valid citation markers inside a JSON label. Strip
// only UUID/numeric citation markers, retaining any substantive extra words.
const normalize = (v: unknown) => String(v ?? "").replace(/\[(?:[0-9a-f-]{36}|\d+)\]/gi, "").toLowerCase().replace(/[^a-z]/g, "");
const status = (v: unknown) => normalize(v) || "pending";
const ticket = (v: unknown) => normalize(v) || "unclassified";

async function main() {
  const started = new Date().toISOString();
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: source, error } = await db.from("data_sources").select("*").eq("source_type", "call_score").eq("slug", "call-scoring").eq("is_active", true).single();
  if (error) throw Error(error.message);
  const examples = new Map<string, Record<string, any>>();
  const priority = (r: Record<string, any>) => (status(r.call_status) === "closed" && r.call_outcome === "FOLLOW_UP") || (status(r.call_status) !== "closed" && r.call_outcome === "CLOSED") ? 1 : 0;
  for (let offset = 0; ; offset += 25) {
    const url = new URL(source.endpoint_url);
    for (const [k, v] of Object.entries({ since: "1970-01-01T00:00:00.000Z", limit: "25", offset: String(offset), include_transcript: "false" })) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { "x-api-key": process.env[source.auth_secret_ref] ?? "" }, signal: AbortSignal.timeout(45_000) });
    if (!res.ok) throw Error(`Source HTTP ${res.status}`);
    const rows = (await res.json()).data as Record<string, any>[];
    for (const row of rows) {
      const key = `${status(row.call_status)}/${ticket(row.ticket_category)}`;
      if (!examples.has(key) || priority(row) > priority(examples.get(key)!)) examples.set(key, row);
    }
    if (rows.length < 25) break;
  }
  const env = Object.fromEntries(readFileSync(resolve("../practiscale-rag-chatbot/.env.local"), "utf8").split(/\r?\n/).flatMap(line => {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/); return m ? [[m[1], m[2].trim().replace(/^["']|["']$/g, "")]] : [];
  }));
  const cookies = new Map<string, string>();
  const auth = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: (all: { name: string; value: string }[]) => all.forEach(c => cookies.set(c.name, c.value)) },
  });
  const login = await auth.auth.signInWithPassword({ email: process.env.SETUP_ADMIN_EMAIL!, password: process.env.SETUP_ADMIN_PASSWORD! });
  if (login.error || (await auth.auth.getUser()).error) throw Error("Live chatbot sign-in failed");
  const headers = { "content-type": "application/json", cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") };
  const results: Record<string, unknown>[] = [];
  const models = process.env.VERIFY_MODELS?.split(",") ?? ["fast", "recommended"];
  const retryReport = process.env.VERIFY_RETRY_REPORT ? JSON.parse(readFileSync(process.env.VERIFY_RETRY_REPORT, "utf8")) : null;
  const retries = retryReport ? new Set<string>(retryReport.results.filter((r: { passed: boolean }) => !r.passed).map((r: { combination: string; model: string }) => `${r.combination}:${r.model}`)) : null;
  const tasks = [...examples].filter(([combination]) => !process.env.VERIFY_COMBINATION || combination === process.env.VERIFY_COMBINATION)
    .flatMap(([combination, row]) => models.map(model => ({ combination, row, model })))
    .filter(t => !retries || retries.has(`${t.combination}:${t.model}`));
  if (!tasks.length) throw Error("No matching verification cases selected");
  for (let i = 0; i < tasks.length; i += 2) {
    await Promise.all(tasks.slice(i, i + 2).map(async ({ combination, row, model }) => {
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(row.created_at));
      // "Analyze" intentionally exercises retrieval + model generation rather
      // than the separate, model-independent operational-report fast path.
      const query = `Analyze ${row.consultant_name}'s calls on ${day}. For the call with prospect ${JSON.stringify(row.prospect_name)}, report only its CURRENT CRM status and closing type from structured metadata. The model's original call_outcome is historical. Return JSON with current_status (Closed, Not Closed, Pending, or Disqualified) and closing_type (High Ticket, Low Ticket, or Unclassified), followed by citations.`;
      try {
        const res = await fetch("https://practiscale-rag-chatbot.vercel.app/api/chat", { method: "POST", headers,
          body: JSON.stringify({ messages: [{ role: "user", content: query }], model, mode: "general", timeZone: "Asia/Karachi" }), signal: AbortSignal.timeout(180_000) });
        const stream = await res.text();
        let answer = ""; let usage: any; const events: any[] = []; const errors: unknown[] = [];
        for (const line of stream.split("\n")) {
          try {
            const v = JSON.parse(line.slice(2));
            if (line.startsWith("0:")) answer += v;
            if (line.startsWith("2:") && Array.isArray(v)) events.push(...v);
            if (line.startsWith("3:")) errors.push(v);
            if (line.startsWith("d:")) usage = v.usage;
          } catch { /* stream control frames */ }
        }
        // Models may include nested citation objects. A non-greedy brace regex
        // truncates valid JSON at the first nested object and creates false fails.
        let parsed: any;
        try {
          const json = answer.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1);
          parsed = JSON.parse(json || "null");
        } catch { /* refusal/malformed output fails below */ }
        // Accept the explicit CRM label alias without treating absent/null
        // model fields as Pending (only the source uses null for Pending).
        if (parsed && typeof parsed === "object") {
          const fields = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [normalize(key), value]));
          parsed.current_status = fields.currentstatus ?? fields.currentcrmstatus;
          parsed.closing_type = fields.closingtype;
        }
        const explicitLabels = typeof parsed?.current_status === "string" && typeof parsed?.closing_type === "string"
          && ["closed", "notclosed", "pending", "disqualified"].includes(normalize(parsed.current_status))
          && ["highticket", "lowticket", "unclassified"].includes(normalize(parsed.closing_type));
        const matches = explicitLabels && status(parsed.current_status) === status(row.call_status) && ticket(parsed.closing_type) === ticket(row.ticket_category);
        if (!matches && process.env.VERIFY_DIAGNOSTICS === "1") {
          const { redactPII } = await import("../src/lib/redact");
          console.log(JSON.stringify({ diagnostic: combination, model, answer: redactPII(answer).slice(0, 1800) }));
        }
        const sourceCount = events.find(e => e.type === "sources")?.sources?.length ?? 0;
        const result = { recordId: row.id, combination, model, httpStatus: res.status, matches, sourceCount, usage, errorCount: errors.length, outputStatus: parsed?.current_status ?? null, outputTicket: parsed?.closing_type ?? null,
          passed: res.ok && !errors.length && sourceCount > 0 && matches && usage?.promptTokens > 0 && usage?.completionTokens > 0 };
        results.push(result); console.log(JSON.stringify(result));
      } catch { const result = { recordId: row.id, combination, model, passed: false, error: "Live verification request failed" }; results.push(result); console.log(JSON.stringify(result)); }
    }));
  }
  const summary = { combinations: examples.size, checks: results.length, passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length };
  const directory = resolve("../verification"); mkdirSync(directory, { recursive: true });
  const path = resolve(directory, `chatbot-call-parity-${started.replace(/[:.]/g, "-")}.json`);
  writeFileSync(path, JSON.stringify({ startedAt: started, finishedAt: new Date().toISOString(), summary, results }, null, 2));
  console.log(JSON.stringify({ summary, report: path }));
  if (summary.failed) process.exitCode = 1;
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
