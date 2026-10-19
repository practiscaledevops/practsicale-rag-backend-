// Copy the source's immutable call number into existing Brain metadata without
// regenerating embeddings. Compare-and-swap preserves concurrent status updates.
import { loadEnvConfig } from "@next/env";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
loadEnvConfig(process.cwd());
async function main() {
  const { supabaseAdmin } = await import("../src/lib/supabase");
  const db = supabaseAdmin();
  const { data: source, error } = await db.from("data_sources").select("*").eq("slug", "call-scoring").single();
  if (error) throw Error(error.message);
  const records = new Map<string, number | null>();
  for (let offset = 0; ; offset += 100) {
    const url = new URL(source.endpoint_url);
    for (const [k, v] of Object.entries({ since: "1970-01-01T00:00:00.000Z", limit: "100", offset: String(offset) })) url.searchParams.set(k, v);
    const response = await fetch(url, { headers: { "x-api-key": process.env[source.auth_secret_ref] ?? "" }, signal: AbortSignal.timeout(45_000) });
    if (!response.ok) throw Error(`Scoring feed HTTP ${response.status}`);
    const rows = (await response.json()).data as any[];
    if (rows.some(r => !("call_sequence" in r))) throw Error("Scoring deployment does not expose call_sequence yet");
    for (const r of rows) records.set(r.id, r.call_sequence ?? null);
    if (rows.length < 100) break;
  }
  const totals: Record<string, unknown> = { calls: records.size, numbered: [...records.values()].filter(n => n != null).length, tables: {} };
  for (const table of ["documents", "chunks"]) {
    let examined = 0, updated = 0, mismatches = 0;
    for (let offset = 0; ; offset += 1000) {
      const query = await db.from(table).select("id,metadata").eq("org_id", source.org_id).eq("data_source_id", source.id).order("id").range(offset, offset + 999);
      if (query.error) throw Error(query.error.message);
      const rows = query.data;
      for (let i = 0; i < rows.length; i += 20) {
        const settled = await Promise.allSettled(rows.slice(i, i + 20).map(async row => {
          examined++;
          const expected = records.get(row.metadata?.source_record_id);
          if (expected === undefined || row.metadata?.call_sequence === expected) return;
          mismatches++;
          if (!process.argv.includes("--apply")) return;
          for (let attempt = 0; attempt < 3; attempt++) {
            const saved = await db.from(table).update({ metadata: { ...row.metadata, call_sequence: expected } })
              .eq("org_id", source.org_id).eq("id", row.id).eq("metadata", JSON.stringify(row.metadata)).select("id");
            if (saved.error) throw Error(saved.error.message);
            if (saved.data.length) { updated++; return; }
            const fresh = await db.from(table).select("metadata").eq("org_id", source.org_id).eq("id", row.id).maybeSingle();
            if (fresh.error) throw Error(fresh.error.message);
            if (!fresh.data || fresh.data.metadata?.call_sequence === expected) return;
            row.metadata = fresh.data.metadata;
          }
          throw Error("Concurrent call metadata changed repeatedly; retry this backfill");
        }));
        const failed = settled.find(r => r.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      }
      if (rows.length < 1000) break;
    }
    (totals.tables as Record<string, unknown>)[table] = { examined, updated, mismatches };
    console.log(JSON.stringify({ table, examined, updated, mismatches, apply: process.argv.includes("--apply") }));
  }
  const directory = resolve("../verification"); mkdirSync(directory, { recursive: true });
  const path = resolve(directory, `call-sequences-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify({ checkedAt: new Date().toISOString(), apply: process.argv.includes("--apply"), ...totals }, null, 2));
  console.log(JSON.stringify({ ...totals, report: path }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
