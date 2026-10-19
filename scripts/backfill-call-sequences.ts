// Copy the source's immutable call number into existing Brain metadata without
// regenerating embeddings. The existing atomic RPC preserves newer revisions.
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
  const documents = new Map<string, any>();
  for (let offset = 0; ; offset += 1000) {
    const q = await db.from("documents").select("id,metadata,source_type,content_hash,title,intelligence_class,domain")
      .eq("org_id", source.org_id).eq("data_source_id", source.id).order("id").range(offset, offset + 999);
    if (q.error) throw Error(q.error.message);
    for (const d of q.data) documents.set(d.id, d);
    if (q.data.length < 1000) break;
  }
  const needed = new Set<string>();
  for (const d of documents.values()) if (records.has(d.metadata.source_record_id) && (d.metadata.call_sequence ?? null) !== records.get(d.metadata.source_record_id)) needed.add(d.id);
  let examined = 0, mismatches = 0;
  for (let offset = 0; ; offset += 1000) {
    const q = await db.from("chunks").select("id,document_id,record:metadata->>source_record_id,sequence:metadata->call_sequence")
      .eq("org_id", source.org_id).eq("data_source_id", source.id).order("id").range(offset, offset + 999);
    if (q.error) throw Error(q.error.message);
    for (const c of q.data) { examined++; if (records.has(c.record) && c.sequence !== records.get(c.record)) { mismatches++; needed.add(c.document_id); } }
    if (q.data.length < 1000) break;
  }
  const targets = [...needed]; let updated = 0;
  if (process.argv.includes("--apply")) for (let i = 0; i < targets.length; i += 30) {
    const settled = await Promise.allSettled(targets.slice(i, i + 30).map(async id => {
      let d = documents.get(id); if (!d) throw Error("Call chunk has no source document");
      for (let attempt = 0; attempt < 3; attempt++) {
        // Existing atomic RPC merges the document metadata into ALL its chunks,
        // preserving per-chunk locators/tokens and every stored embedding. Its
        // revision guard rejects stale status snapshots; advisory locks serialize
        // with normal ingestion. A changed body rejects this metadata-only call.
        const result = await db.rpc("sync_source_document", {
          p_org_id: source.org_id, p_source_id: source.id, p_source_type: d.source_type,
          p_record_id: d.metadata.source_record_id, p_content_hash: d.content_hash, p_title: d.title,
          p_metadata: { ...d.metadata, call_sequence: records.get(d.metadata.source_record_id) },
          p_lane: { intelligence_class: d.intelligence_class, domain: d.domain }, p_chunks: null,
        });
        if (!result.error) { updated++; return; }
        if (attempt === 2) throw Error(result.error.message);
        const fresh = await db.from("documents").select("id,metadata,source_type,content_hash,title,intelligence_class,domain").eq("org_id", source.org_id).eq("id", id).single();
        if (fresh.error) throw Error(fresh.error.message); d = fresh.data;
      }
    }));
    const failed = settled.find(r => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    console.log(JSON.stringify({ refreshedDocuments: Math.min(i + 30, targets.length), total: targets.length }));
  }
  totals.tables = { documents: documents.size, chunks: examined, chunkMismatches: mismatches, documentsNeedingRefresh: targets.length, refreshed: updated };
  const directory = resolve("../verification"); mkdirSync(directory, { recursive: true });
  const path = resolve(directory, `call-sequences-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify({ checkedAt: new Date().toISOString(), apply: process.argv.includes("--apply"), ...totals }, null, 2));
  console.log(JSON.stringify({ ...totals, report: path }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
