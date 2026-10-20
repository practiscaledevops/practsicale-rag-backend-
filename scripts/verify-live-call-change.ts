// Passive observer for a user-authorized, real UI edit and its restoration.
// NEVER writes source data, sends a webhook, or drains the queue. The source's
// normal admin UI/API must generate and deliver the real update notification.
import { loadEnvConfig } from "@next/env";
import { createServerClient } from "@supabase/ssr";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
loadEnvConfig(process.cwd());
const checkpoint = resolve("../verification/live-call-change-checkpoint.json");
const normal = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const status = (v: unknown) => normal(v) || "pending";
const ticket = (v: unknown) => normal(v) || "unclassified";
const localDate = (ts: unknown) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(String(ts)));
const fingerprint = (row: Record<string, unknown>) => createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(row).filter(([k]) => k !== "updated_at").sort(([a], [b]) => a.localeCompare(b))))).digest("hex");
async function main() {
  const { supabaseAdmin } = await import("../src/lib/supabase");
  const db = supabaseAdmin();
  const { data: source, error } = await db.from("data_sources").select("*").eq("slug", "call-scoring").eq("source_type", "call_score").eq("is_active", true).single();
  if (error) throw Error(error.message);
  async function sourceCall(id: string) {
    const url = new URL(source.endpoint_url);
    url.searchParams.set("report_id", id); url.searchParams.set("include_transcript", "true");
    const response = await fetch(url, { headers: { "x-api-key": process.env[source.auth_secret_ref] ?? "" }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw Error(`Scoring API HTTP ${response.status}`);
    const rows = (await response.json()).data;
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].id !== id) throw Error("Exact scoring identity not returned");
    return rows[0];
  }
  async function events(id: string) {
    const result = await db.from("scoring_sync_events").select("id,status,created_at,completed_at,last_error").eq("org_id", source.org_id).eq("data_source_id", source.id).eq("record_id", id).order("created_at", { ascending: false }).limit(30);
    if (result.error) throw Error(result.error.message);
    return result.data ?? [];
  }
  const command = process.argv[2];
  if (command === "snapshot") {
    if (existsSync(checkpoint)) throw Error("Checkpoint exists; reuse it or inspect restoration before starting another call");
    const prospect = process.argv.slice(3).join(" ");
    const found = await db.from("documents").select("metadata").eq("org_id", source.org_id).eq("data_source_id", source.id).eq("source_type", "call_score").eq("metadata->>prospect_name", prospect);
    if (found.error || found.data?.length !== 1) throw Error("Expected one exact candidate in Brain");
    const id = found.data[0].metadata.source_record_id;
    const original = await sourceCall(id);
    const eventRows = await events(id);
    const snapshot = { startedAt: new Date().toISOString(), recordId: id, sourceId: source.id, original: { call_status: original.call_status ?? null, ticket_category: original.ticket_category ?? null, call_outcome: original.call_outcome ?? null, call_sequence: original.call_sequence ?? null, overall_score: original.overall_score, performance_band: original.performance_band, updated_at: original.updated_at }, originalFingerprint: fingerprint(original), lastRevision: original.updated_at, knownEventIds: eventRows.map(e => e.id), phases: [] };
    writeFileSync(checkpoint, JSON.stringify(snapshot, null, 2));
    console.log(JSON.stringify({ checkpoint, recordId: id, original: snapshot.original })); return;
  }
  if (command !== "watch") throw Error("Use snapshot <exact prospect>, or watch <phase> <status> <ticket>");
  const state = JSON.parse(readFileSync(checkpoint, "utf8"));
  const [phase, expectedStatus, expectedTicket] = process.argv.slice(3);
  if (!phase || !expectedStatus || !expectedTicket || state.phases.some((p: { phase: string }) => p.phase === phase)) throw Error("Specify a new phase, status and ticket");
  let current: any = null, sourceSeenAt = 0, brainSeenAt = 0, eventSeenAt = 0;
  let syncedChunks = 0; let currentEvents: Awaited<ReturnType<typeof events>> = [];
  const deadline = Date.now() + 300_000;
  console.log(JSON.stringify({ watching: phase, recordId: state.recordId, expectedStatus, expectedTicket, passiveOnly: true }));
  while (Date.now() < deadline) {
    if (!current) {
      const row = await sourceCall(state.recordId);
      if (Date.parse(row.updated_at) > Date.parse(state.lastRevision) && status(row.call_status) === status(expectedStatus) && ticket(row.ticket_category) === ticket(expectedTicket)) {
        current = row; sourceSeenAt = Date.now();
        if (row.call_outcome !== state.original.call_outcome || row.call_sequence !== state.original.call_sequence) throw Error("Original outcome or sequence changed unexpectedly; restore the call");
        console.log(JSON.stringify({ phase, sourceObserved: true, sourceRevision: row.updated_at, status: row.call_status, ticket: row.ticket_category, score: row.overall_score }));
      }
    }
    if (current) {
      const docs = await db.from("documents").select("id,source_type,metadata").eq("org_id", source.org_id).eq("data_source_id", source.id).eq("metadata->>source_record_id", state.recordId);
      if (docs.error) throw Error(docs.error.message);
      const chunks = await db.from("chunks").select("id,document_id,metadata").eq("org_id", source.org_id).eq("data_source_id", source.id).eq("metadata->>source_record_id", state.recordId).order("id").limit(1000);
      if (chunks.error) throw Error(chunks.error.message);
      const matches = (meta: any) => Date.parse(meta.source_updated_at) === Date.parse(current.updated_at) && status(meta.call_status) === status(expectedStatus) && ticket(meta.ticket_category) === ticket(expectedTicket) && meta.call_outcome === state.original.call_outcome && meta.call_sequence === state.original.call_sequence && Number(meta.overall_score) === Number(current.overall_score);
      const docRows = docs.data ?? [], chunkRows = chunks.data ?? [];
      const fullMatch = docRows.length === 2 && new Set(docRows.map(d => d.source_type)).size === 2 && docRows.every(d => matches(d.metadata)) && chunkRows.length > 0 && chunkRows.length < 1000 && docRows.every(d => chunkRows.some(c => c.document_id === d.id)) && chunkRows.every(c => matches(c.metadata));
      if (fullMatch && !brainSeenAt) { brainSeenAt = Date.now(); syncedChunks = chunkRows.length; console.log(JSON.stringify({ phase, brainMatched: true, documents: docRows.length, chunks: syncedChunks, secondsFromSource: (brainSeenAt - Date.parse(current.updated_at)) / 1000 })); }
      currentEvents = await events(state.recordId);
      const fresh = currentEvents.filter(e => !state.knownEventIds.includes(e.id));
      if (fresh.length && !eventSeenAt) eventSeenAt = Date.now();
      if (brainSeenAt && fresh.length) break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!current || !brainSeenAt || !currentEvents.some(e => !state.knownEventIds.includes(e.id))) throw Error("Automatic webhook synchronization did not reach Brain within five minutes; restore the call");
  const env = Object.fromEntries(readFileSync(resolve("../practiscale-rag-chatbot/.env.local"), "utf8").split(/\r?\n/).flatMap(line => { const m = line.match(/^([A-Z_0-9]+)=(.*)$/); return m ? [[m[1], m[2].trim().replace(/^["']|["']$/g, "")]] : []; }));
  const cookies = new Map<string, string>();
  const auth = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: (all: { name: string; value: string }[]) => all.forEach(c => cookies.set(c.name, c.value)) } });
  const login = await auth.auth.signInWithPassword({ email: process.env.SETUP_ADMIN_EMAIL!, password: process.env.SETUP_ADMIN_PASSWORD! });
  if (login.error) throw Error("Live chatbot sign-in failed; restore the call");
  const response = await fetch("https://practiscale-rag-chatbot.vercel.app/api/chat", { method: "POST", headers: { "content-type": "application/json", cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") }, body: JSON.stringify({ messages: [{ role: "user", content: `give me report of all calls on ${localDate(current.created_at)}`, createdAt: new Date().toISOString() }], timeZone: "Asia/Karachi", persistTurn: false }), signal: AbortSignal.timeout(180_000) });
  const stream = await response.text(); const chatbotSeenAt = Date.now(); let answer = ""; const errors: unknown[] = [];
  for (const line of stream.split("\n")) { try { if (line.startsWith("0:")) answer += JSON.parse(line.slice(2)); if (line.startsWith("3:")) errors.push(JSON.parse(line.slice(2))); } catch { /* stream framing */ } }
  const rows = answer.split("\n").filter(line => line.startsWith("|")).map(line => line.split("|").slice(1, -1).map(c => c.trim()));
  const headers = rows.find(row => row.some(c => normal(c) === "currentcrmstatus") && row.some(c => normal(c) === "prospect"));
  if (!response.ok || errors.length || !headers) throw Error("Live chatbot report unavailable; restore the call");
  const col = (name: string) => headers.findIndex(h => normal(h) === normal(name));
  const matches = rows.filter(row => normal(row[col("Consultant")]) === normal(current.consultant_name) && normal(row[col("Prospect")]) === normal(current.prospect_name));
  const expectedOutcome = ({ FOLLOW_UP: "Follow Up", LOST: "Lost", CLOSED: "Closed" } as Record<string, string>)[current.call_outcome] ?? "Unknown";
  const row = matches[0];
  const passed = matches.length === 1 && status(row[col("Current CRM Status")]) === status(expectedStatus) && ticket(row[col("Closing Type")]) === ticket(expectedTicket) && normal(row[col("Original Call Outcome")]) === normal(expectedOutcome) && row[col("Score")] === `${current.overall_score}/100`;
  const restoredFingerprintMatches = phase === "restored" ? fingerprint(current) === state.originalFingerprint : null;
  // The report is checked as soon as Brain is current. Wait for the SAME real
  // event's metrics/acknowledgement separately before allowing the next UI edit.
  while (Date.now() < deadline && !currentEvents.some(e => !state.knownEventIds.includes(e.id) && e.status === "completed" && !e.last_error)) {
    await new Promise(resolve => setTimeout(resolve, 1000)); currentEvents = await events(state.recordId);
  }
  const eventCompleted = currentEvents.some(e => !state.knownEventIds.includes(e.id) && e.status === "completed" && !e.last_error);
  const result = { phase, sourceRevision: current.updated_at, sourceObservedAt: new Date(sourceSeenAt).toISOString(), brainObservedAt: new Date(brainSeenAt).toISOString(), chatbotObservedAt: new Date(chatbotSeenAt).toISOString(), sourceToBrainSeconds: (brainSeenAt - Date.parse(current.updated_at)) / 1000, sourceToChatbotSeconds: (chatbotSeenAt - Date.parse(current.updated_at)) / 1000, newWebhookEvents: currentEvents.filter(e => !state.knownEventIds.includes(e.id)), eventCompleted, documentsMatched: 2, chunksMatched: syncedChunks, originalOutcomePreserved: true, sequencePreserved: true, chatbot: { http: response.status, model: response.headers.get("x-model"), status: row?.[col("Current CRM Status")], ticket: row?.[col("Closing Type")], originalOutcome: row?.[col("Original Call Outcome")], score: row?.[col("Score")], passed }, restoredFingerprintMatches, passed: passed && restoredFingerprintMatches !== false && eventCompleted };
  state.phases.push(result); state.lastRevision = current.updated_at; state.knownEventIds = currentEvents.map(e => e.id);
  writeFileSync(checkpoint, JSON.stringify(state, null, 2));
  writeFileSync(resolve(`../verification/live-call-change-${phase}.md`), answer);
  console.log(JSON.stringify(result));
  if (!result.passed) throw Error("Live classification/restoration check failed; inspect checkpoint and restore the call");
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
