// Fill only missing scoring-source vectors. No document deletion, prompt changes
// or fallback vectors. Row IDs are immutable across atomic body replacements,
// and the final compare-and-set prevents overwriting a concurrent repair.
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
process.env.EMBEDDINGS_STRICT = "1";
async function main() {
  const { supabaseAdmin } = await import("../src/lib/supabase");
  const { embedForIngest } = await import("../src/lib/embeddings");
  const db = supabaseAdmin();
  const { data: sources, error } = await db.from("data_sources").select("id,org_id").eq("source_type", "call_score").eq("is_active", true);
  if (error) throw Error(error.message);
  for (const source of sources ?? []) {
    let repaired = 0;
    for (;;) {
      const { data: rows, error } = await db.from("chunks").select("id,content,context").eq("org_id", source.org_id).eq("data_source_id", source.id).is("embedding", null).order("id").limit(100);
      if (error) throw Error(error.message);
      if (!rows?.length) break;
      if (!process.argv.includes("--apply")) { console.log(JSON.stringify({ sourceId: source.id, missingAtLeast: rows.length, dryRun: true })); break; }
      const vectors = await embedForIngest(rows.map(r => r.context ? `${r.context}\n\n${r.content}` : r.content));
      if (vectors.length !== rows.length || vectors.some(v => !v || v.length !== 1024 || v.some(n => !Number.isFinite(n)) || v.every(n => n === 0))) throw Error("Provider returned an invalid embedding; no repairs written");
      for (let i = 0; i < rows.length; i++) {
        const { data, error } = await db.from("chunks").update({ embedding: vectors[i] }).eq("id", rows[i].id).eq("org_id", source.org_id).eq("data_source_id", source.id).is("embedding", null).select("id");
        if (error) throw Error(error.message);
        repaired += data?.length ?? 0;
      }
    }
    console.log(JSON.stringify({ sourceId: source.id, repaired }));
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
