// Back-fill raw call transcripts into the Brain. For every call-scoring pull
// source in the org, pages ALL reports with include_transcript=true and ingests
// a `transcript` document for each call that has one. Idempotent (content-hash):
// re-running only adds calls whose transcript isn't stored yet.
//
//   npm run backfill:transcripts

import { readFileSync } from "fs";
// Type-only import (erased at compile time, so it never loads the module before
// env is ready). The runtime value is dynamically imported in main().
import type { DataSourceRow } from "../src/lib/connectors/pull";

function loadEnvLocal(path = ".env.local"): void {
  let text: string;
  try { text = readFileSync(path, "utf-8"); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("="); if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvLocal();

const SOURCE_COLUMNS =
  "id, org_id, name, slug, source_type, kind, endpoint_url, http_method, auth_type, " +
  "auth_secret_ref, headers, query_params, records_path, record_id_field, cursor_field, cursor_param, cursor_value";

async function main() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("✖ Missing Supabase env"); process.exit(1);
  }
  const { supabaseAdmin } = await import("../src/lib/supabase");
  const { backfillTranscripts } = await import("../src/lib/connectors/pull");
  const db = supabaseAdmin();

  const { data: org } = await db.from("orgs").select("id, name").order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (!org) throw new Error("no org found — run setup:live first");
  console.log(`• Org: ${org.name} (${org.id})`);

  // Every call-scoring pull source in the org (transcripts come from these).
  const { data: sources, error } = await db
    .from("data_sources")
    .select(SOURCE_COLUMNS)
    .eq("org_id", org.id as string)
    .eq("kind", "pull_http")
    .eq("source_type", "call_score");
  if (error) throw new Error(error.message);
  const rows = (sources ?? []) as unknown as DataSourceRow[];
  if (rows.length === 0) throw new Error("no call_score pull source found for this org");

  let calls = 0;
  let created = 0;
  let skipped = 0;
  for (const source of rows) {
    console.log(`• Source: ${source.name}`);
    const r = await backfillTranscripts(source, {
      db,
      onProgress: ({ done, total, created: c, skipped: sk }) => {
        process.stdout.write(`\r  ${done}/${total} · ${c} created / ${sk} skipped   `);
      },
    });
    process.stdout.write("\n");
    calls += r.calls;
    created += r.transcriptsCreated;
    skipped += r.transcriptsSkipped;
  }

  console.log(`✓ ${calls} calls with a transcript · ${created} created / ${skipped} already present`);
}

main().catch((e) => { console.error("✖ backfill-transcripts failed:", e instanceof Error ? e.message : e); process.exit(1); });
