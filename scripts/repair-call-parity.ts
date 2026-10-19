// Prioritize only the identities reported by verify-call-parity. Source data is
// never edited. Uses the same authoritative refresh and organization lease as
// the webhook worker; metrics must succeed before any inbox event is completed.
import { loadEnvConfig } from "@next/env";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
loadEnvConfig(process.cwd());
process.env.EMBEDDINGS_STRICT = "1";

async function main() {
  const path = process.argv[2]; if (!path) throw Error("Pass the parity report JSON path");
  const report = JSON.parse(readFileSync(path, "utf8"));
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { syncScoringRecord } = await import("../src/lib/connectors/pull");
  const { rebuildCallScoreMetrics } = await import("../src/lib/call-score-metrics");
  for (const audit of report.audits) {
    const { data: source, error } = await db.from("data_sources").select("*").eq("id", audit.sourceId).eq("source_type", "call_score").eq("is_active", true).single();
    if (error || !source) throw Error("Registered source is unavailable");
    const targets = new Set<string>(audit.issues.map((i: { recordId?: string }) => i.recordId).filter(Boolean));
    // Resolve legacy orphan-chunk issues recorded before recordId was included.
    const docIds = audit.issues.filter((i: { recordId?: string; documentId?: string }) => !i.recordId && i.documentId).map((i: { documentId: string }) => i.documentId);
    if (docIds.length) {
      const { data, error } = await db.from("documents").select("metadata").eq("org_id", source.org_id).eq("data_source_id", source.id).in("id", docIds);
      if (error) throw Error(error.message);
      for (const row of data ?? []) if (row.metadata?.source_record_id) targets.add(row.metadata.source_record_id);
    }
    if (!targets.size) { console.log(JSON.stringify({ source: source.name, repaired: 0 })); continue; }
    const token = randomUUID();
    // Match the claim function's org exclusion while allowing an administrator
    // to prioritize confirmed gaps instead of another historical queue item.
    let locked = false;
    for (let attempt = 0; attempt < 18; attempt++) {
      const { error } = await db.from("scoring_sync_locks").insert({ org_id: source.org_id, lease_token: token, locked_until: new Date(Date.now() + 300_000).toISOString() });
      if (!error) { locked = true; break; }
      if (error.code !== "23505") throw Error(error.message);
      await db.from("scoring_sync_locks").delete().eq("org_id", source.org_id).lt("locked_until", new Date().toISOString());
      await new Promise(done => setTimeout(done, 10_000));
    }
    if (!locked) throw Error("Another source refresh still holds the organization lease");
    const heartbeat = setInterval(() => {
      void db.from("scoring_sync_locks").update({ locked_until: new Date(Date.now() + 300_000).toISOString() }).eq("org_id", source.org_id).eq("lease_token", token).then(({ error }) => { if (error) console.error("Lease renewal failed"); });
    }, 30_000);
    const completed: string[] = [];
    try {
      const ids = [...targets];
      // Snapshot only existing events. A notification arriving during this run
      // must remain pending so a later source change is never acknowledged early.
      const { data: events, error } = await db.from("scoring_sync_events").select("id,record_id").eq("org_id", source.org_id).eq("data_source_id", source.id).eq("status", "pending").in("record_id", ids);
      if (error) throw Error(error.message);
      for (let i = 0; i < ids.length; i += 3) {
        const batch = await Promise.allSettled(ids.slice(i, i + 3).map(async id => {
          await syncScoringRecord(db, source, id);
          completed.push(id);
          console.log(JSON.stringify({ refreshed: completed.length, total: ids.length }));
        }));
        const failed = batch.find(r => r.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      }
      await rebuildCallScoreMetrics(db, source.org_id, { createdBy: "parity-repair" });
      const ackIds = (events ?? []).map(e => e.id);
      if (ackIds.length) {
        const { error } = await db.from("scoring_sync_events").update({ status: "completed", completed_at: new Date().toISOString(), last_error: null }).eq("org_id", source.org_id).eq("data_source_id", source.id).eq("status", "pending").in("id", ackIds);
        if (error) throw Error(error.message);
      }
      console.log(JSON.stringify({ source: source.name, repaired: completed.length, acknowledgedEvents: ackIds.length, metricsRefreshed: true }));
    } finally {
      clearInterval(heartbeat);
      await db.from("scoring_sync_locks").delete().eq("org_id", source.org_id).eq("lease_token", token);
    }
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
