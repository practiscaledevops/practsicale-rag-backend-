import { loadEnvConfig } from "@next/env";
import { createServerClient } from "@supabase/ssr";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
loadEnvConfig(process.cwd());
const clean = (s: unknown) => String(s ?? "").replace(/\[[^\]]*\]/g, "").replace(/[*_`]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
async function main() {
  const { supabaseAdmin } = await import("../src/lib/supabase");
  const db = supabaseAdmin();
  const { data: source, error } = await db.from("data_sources").select("*").eq("slug", "call-scoring").single();
  if (error) throw Error(error.message);
  const localDate = (v: string | number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(v));
  const today = localDate(Date.now());
  const allHistory = process.env.REPORT_ALL === "1";
  const yesterday = process.env.REPORT_DATE ?? new Date(Date.parse(`${today}T12:00:00Z`) - 86400_000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yesterday)) throw Error("REPORT_DATE must be YYYY-MM-DD");
  const records: any[] = [];
  for (let offset = 0; ; offset += 25) {
    const url = new URL(source.endpoint_url);
    for (const [k, v] of Object.entries({ since: "1970-01-01T00:00:00.000Z", limit: "25", offset: String(offset) })) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { "x-api-key": process.env[source.auth_secret_ref] ?? "" }, signal: AbortSignal.timeout(45_000) });
    if (!res.ok) throw Error(`Source HTTP ${res.status}`);
    const rows = (await res.json()).data as any[];
    records.push(...rows.filter(r => allHistory || localDate(r.created_at) === yesterday));
    if (rows.length < 25) break;
  }
  const dates = records.map(r => localDate(r.created_at)).sort();
  const scope = allHistory ? { from: dates[0], to: dates[dates.length - 1] } : { from: yesterday, to: yesterday };
  if (!records.length) throw Error("No source records in verification scope");
  const query = process.env.REPORT_QUERY ?? (allHistory ? `give me report of all calls from ${scope.from} to ${scope.to}` : process.env.REPORT_DATE ? `give me report of calls on ${yesterday}` : "give me report of yesterday calls");
  const env = Object.fromEntries(readFileSync(resolve("../practiscale-rag-chatbot/.env.local"), "utf8").split(/\r?\n/).flatMap(line => {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/); return m ? [[m[1], m[2].trim().replace(/^["']|["']$/g, "")]] : [];
  }));
  const cookies = new Map<string, string>();
  const auth = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: (all: { name: string; value: string }[]) => all.forEach(c => cookies.set(c.name, c.value)) },
  });
  const login = await auth.auth.signInWithPassword({ email: process.env.SETUP_ADMIN_EMAIL!, password: process.env.SETUP_ADMIN_PASSWORD! });
  if (login.error || (await auth.auth.getUser()).error) throw Error("Chatbot sign-in failed");
  const models = process.env.REPORT_MODELS?.split(",").filter(Boolean) ?? [process.env.REPORT_MODEL ?? ""];
  for (const model of models) {
  const res = await fetch("https://practiscale-rag-chatbot.vercel.app/api/chat", { method: "POST",
    headers: { "content-type": "application/json", cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    // Deliberately omit model/tier and column instructions: test the live defaults.
    body: JSON.stringify({ messages: [
      ...(process.env.REPORT_BAD_HISTORY ? [{ role: "user", content: "check yesterday calls", createdAt: "2026-10-19T12:00:00Z" }, { role: "assistant", content: "Yesterday was October 18. There were zero calls. The newest call is October 6." }] : []),
      { role: "user", content: query, createdAt: new Date().toISOString() }], ...(model ? { model } : {}), mode: process.env.REPORT_MODE ?? "general", timeZone: "Asia/Karachi" }), signal: AbortSignal.timeout(270_000) });
  const stream = await res.text(); let answer = ""; const errors: unknown[] = []; const events: any[] = [];
  for (const line of stream.split("\n")) { try { const value = JSON.parse(line.slice(2)); if (line.startsWith("0:")) answer += value; if (line.startsWith("3:")) errors.push(value); if (line.startsWith("2:") && Array.isArray(value)) events.push(...value); } catch { /* stream frames */ } }
  const tables: string[][] = []; let current: string[] = [];
  for (const line of [...answer.split("\n"), ""]) {
    if (line.trim().startsWith("|")) current.push(line.trim());
    else if (current.length) { tables.push(current); current = []; }
  }
  const lines = tables.find(t => /closing|ticket/i.test(t[0]) && /status/i.test(t[0]) && /prospect/i.test(t[0])) ?? [];
  const cells = (line: string) => line.split("|").slice(1, -1).map(s => s.trim());
  const index = lines.findIndex(l => /closing|ticket/i.test(l) && /status/i.test(l) && /consultant/i.test(l));
  const headers = index < 0 ? [] : cells(lines[index]); const normalized = headers.map(clean);
  const columns = {
    consultant: normalized.findIndex(h => h.includes("consultant")), prospect: normalized.findIndex(h => h.includes("prospect")),
    sequence: normalized.findIndex(h => /followup|sequence|callnumber|callno/.test(h) && !/outcome/.test(h)),
    original: normalized.findIndex(h => /original.*outcome|calloutcome/.test(h)),
    status: normalized.findIndex(h => /crm.*status|currentstatus/.test(h)),
    ticket: normalized.findIndex(h => /closingtype|ticket/.test(h)),
    time: normalized.findIndex(h => h.startsWith("time")), practice: normalized.findIndex(h => h === "practice"),
    score: normalized.findIndex(h => h === "score"), band: normalized.findIndex(h => h === "band"), duration: normalized.findIndex(h => h === "duration"),
  };
  const rows = lines.slice(index + 1).filter(l => !/^\|[\s:|\-]+\|$/.test(l)).map(cells).filter(r => r.length === headers.length);
  // Match a multiset of complete rows, including local minute timestamps.
  // Consultant+prospect alone is not unique across a historical call roster.
  const unusedRows = new Set(rows.map((_, i) => i));
  const localTime = (v: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(v));
  const results = records.map(r => {
    const expectedStatus = clean(r.call_status || "Pending"), expectedTicket = clean(r.ticket_category || "Unclassified");
    const expectedOriginal = clean(({ FOLLOW_UP: "Follow Up", LOST: "Lost", CLOSED: "Closed" } as Record<string, string>)[r.call_outcome] ?? "Unknown");
    const matchesRecord = (row: string[]) => {
      const sequence = row[columns.sequence]?.match(/\b(?:Call\s*)?(\d+)\b/i)?.[1];
      return clean(row[columns.consultant]) === clean(r.consultant_name || "Unknown") && clean(row[columns.prospect]) === clean(r.prospect_name || "Unknown")
        && clean(row[columns.time]) === clean(`${localDate(r.created_at)} ${localTime(r.created_at)}`)
        && clean(row[columns.status]) === expectedStatus && clean(row[columns.ticket]) === expectedTicket
        && clean(row[columns.original]) === expectedOriginal && (r.call_sequence == null ? /unknown|unavailable|notrecorded/i.test(row[columns.sequence]) : Number(sequence) === r.call_sequence)
        && clean(row[columns.practice]) === clean(r.practice_type || "Unknown")
        && clean(row[columns.score]) === clean(r.overall_score == null ? "Unknown" : `${r.overall_score}/100`)
        && clean(row[columns.band]) === clean(r.performance_band || "Unknown")
        && clean(row[columns.duration]) === clean(r.call_duration_minutes == null ? "Unknown" : `${r.call_duration_minutes} min`);
    };
    const match = [...unusedRows].find(i => matchesRecord(rows[i]));
    const row = match == null ? undefined : rows[match];
    if (match != null) unusedRows.delete(match);
    const sequenceText = row?.[columns.sequence] ?? "";
    return { recordId: r.id, passed: match != null,
      output: row ? { sequence: sequenceText, original: row[columns.original], status: row[columns.status], closingType: row[columns.ticket] } : null };
  });
  // Independently compute expected summaries from the raw scoring feed; do not
  // reuse the product's aggregation helper in this end-to-end comparison.
  const groups = new Map<string, { consultant: string; counts: number[] }>();
  for (const r of records) {
    const key = r.consultant_id || clean(r.consultant_name);
    const group = groups.get(key) ?? { consultant: r.consultant_name || "Unknown consultant", counts: Array(7).fill(0) };
    const closed = r.call_status === "closed";
    const increments = [1, Number(r.call_outcome === "FOLLOW_UP"), Number(closed && r.ticket_category === "high_ticket"), Number(closed && r.ticket_category === "low_ticket"), Number(closed), Number(r.call_status === "not_closed"), Number(!r.call_status || r.call_status === "pending")];
    increments.forEach((n, i) => group.counts[i] += n); groups.set(key, group);
  }
  const summaryTable = tables.find(t => /total\s*calls/i.test(t[0]) && /consultant/i.test(t[0])) ?? [];
  const summaryHeaders = summaryTable.length ? cells(summaryTable[0]) : [];
  const normalizedSummaryHeaders = summaryHeaders.map(clean);
  const countHeaders = ["totalcalls", "followups", "highticketclosings", "lowticketclosings", "closed", "notclosed", "pending", "disqualified", "otherstatus", "unclassifiedclosings"];
  const extraCounts = (r: any) => [Number(r.call_status === "disqualified"), Number(!!r.call_status && !["closed", "not_closed", "pending", "disqualified"].includes(r.call_status)), Number(r.call_status === "closed" && !["high_ticket", "low_ticket"].includes(r.ticket_category))];
  // Keep the daily verifier compatible with optional zero-valued columns while
  // validating all nonzero states and unclassified closes in all-history mode.
  for (const g of groups.values()) g.counts.push(0, 0, 0);
  for (const r of records) {
    const key = r.consultant_id || clean(r.consultant_name);
    extraCounts(r).forEach((n, i) => groups.get(key)!.counts[i + 7] += n);
  }
  const countColumns = countHeaders.map(h => normalizedSummaryHeaders.indexOf(h));
  const consultantColumn = normalizedSummaryHeaders.findIndex(h => h.includes("consultant"));
  const summaryRows = summaryTable.slice(1).filter(l => !/^\|[\s:|\-]+\|$/.test(l)).map(cells);
  const totals = Array(10).fill(0); for (const g of groups.values()) g.counts.forEach((n, i) => totals[i] += n);
  const expectedSummaryRows = [...groups.values(), { consultant: "Total", counts: totals }];
  const unusedSummaryRows = new Set(summaryRows.map((_, i) => i));
  const summaryResults = expectedSummaryRows.map(expected => {
    const readCounts = (row: string[]) => countColumns.map((col, i) => col < 0 && i >= 7 && totals[i] === 0 ? "0" : clean(row[col]));
    const match = [...unusedSummaryRows].find(i => clean(summaryRows[i][consultantColumn]) === clean(expected.consultant) && readCounts(summaryRows[i]).every((v, j) => /^\d+$/.test(v) && Number(v) === expected.counts[j]));
    const values = match == null ? [] : readCounts(summaryRows[match]);
    if (match != null) unusedSummaryRows.delete(match);
    return { consultant: expected.consultant, expected: expected.counts, actual: values,
      passed: match != null };
  });
  const consultantSummaryPassed = consultantColumn >= 0 && countColumns.every((c, i) => c >= 0 || (i >= 7 && totals[i] === 0)) && summaryRows.length === expectedSummaryRows.length && summaryResults.every(r => r.passed);
  const summary = { date: allHistory ? scope : yesterday, model: res.headers.get("x-model"), http: res.status, expectedCalls: records.length, reportedRows: rows.length,
    requiredColumnsPresent: Object.values(columns).every(c => c >= 0), matchedCalls: results.filter(r => r.passed).length, errors: errors.length,
    expectedConsultants: groups.size, consultantSummaryPassed, totals: Object.fromEntries(countHeaders.map((h, i) => [h, totals[i]])),
    passed: res.ok && res.headers.get("x-model") === ({ fast: "gpt-6-luna", recommended: "gpt-6.1-sol", max: "gpt-6-astra" }[model] ?? (model || "gpt-6.1-sol")) && records.length > 0 && Object.values(columns).every(c => c >= 0) && rows.length === records.length && results.every(r => r.passed) && errors.length === 0 && consultantSummaryPassed };
  const directory = resolve("../verification"); mkdirSync(directory, { recursive: true });
  const path = resolve(directory, `live-daily-report-${Date.now()}.json`);
  const answerPath = path.replace(/\.json$/, ".md"); writeFileSync(answerPath, answer);
  writeFileSync(path, JSON.stringify({ checkedAt: new Date().toISOString(), summary, headers, summaryHeaders, summaryResults, results, answerPath }, null, 2));
  console.log(JSON.stringify({ summary, headers, summaryHeaders, failed: results.filter(r => !r.passed).slice(0, 10), failedSummaryRows: summaryResults.filter(r => !r.passed), report: path }));
  if (!summary.passed) process.exitCode = 1;
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
