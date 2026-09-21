// Rebuild Performance Memory from the call-scoring data (consultant entities +
// company/consultant/segment metrics + the "Sales Call Performance" snapshot
// object). Idempotent. Use to populate now; the cron refreshes it going forward.
//
//   npm run rebuild:call-metrics

import { readFileSync } from "fs";
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

async function main() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("✖ Missing Supabase env"); process.exit(1);
  }
  const { supabaseAdmin } = await import("../src/lib/supabase");
  const { rebuildCallScoreMetrics } = await import("../src/lib/call-score-metrics");
  const db = supabaseAdmin();
  const { data: org } = await db.from("orgs").select("id, name").order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (!org) throw new Error("no org found — run setup:live first");
  console.log(`• Org: ${org.name} (${org.id})`);
  const r = await rebuildCallScoreMetrics(db, org.id as string, { createdBy: "rebuild-call-metrics script" });
  console.log(`✓ ${r.calls} calls · ${r.consultants} consultants · ${r.segments} segments`);
  console.log(`✓ ${r.metricsWritten} metrics, ${r.entitiesUpserted} entities`);
  console.log(`✓ team avg score ${r.avgScore}/100 · close rate ${r.closeRate}%`);
  console.log(`✓ snapshot object: ${r.snapshotRef}`);
}

main().catch((e) => { console.error("✖ rebuild-call-metrics failed:", e instanceof Error ? e.message : e); process.exit(1); });
