// Resumable administrator runner for the SAME durable inbox as the live worker.
// Claims at most ten events under an org lease; renews both leases while working.
// Fetches every call from the authoritative feed and acknowledges only after the
// actual document/chunk refresh AND derived metrics rebuild have succeeded.
import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
loadEnvConfig(process.cwd());
process.env.EMBEDDINGS_STRICT = "1";

async function main() {
  const { supabaseAdmin } = await import("../src/lib/supabase");
  const { syncScoringRecord } = await import("../src/lib/connectors/pull");
  const { rebuildCallScoreMetrics } = await import("../src/lib/call-score-metrics");
  const db = supabaseAdmin();
  const deadline = Date.now() + 2 * 60 * 60_000;
  let completed = 0;
  let emptyPolls = 0;
  while (Date.now() < deadline) {
    const token = randomUUID();
    const { data, error } = await db.rpc("claim_scoring_sync_events", { p_token: token, p_limit: 10 });
    if (error) throw Error(`Inbox claim failed: ${error.code}`);
    const events = data as { id: string; org_id: string; data_source_id: string; record_id: string }[];
    if (!events?.length) {
      const { count, error } = await db.from("scoring_sync_events").select("id", { count: "exact", head: true }).in("status", ["pending", "running"]);
      if (error) throw Error(`Inbox count failed: ${error.code}`);
      console.log(JSON.stringify({ completed, outstanding: count, waitingForLeaseOrRetry: !!count }));
      if (!count) return;
      if (++emptyPolls > 60) throw Error("Inbox is still waiting after ten minutes; inspect leases/retries");
      await new Promise(resolve => setTimeout(resolve, 10_000));
      continue;
    }
    emptyPolls = 0;
    const orgId = events[0].org_id;
    let leaseError = false;
    let renewing = false;
    const renew = async () => {
      if (renewing) return;
      renewing = true;
      try {
        const until = new Date(Date.now() + 300_000).toISOString();
        const { data, error } = await db.from("scoring_sync_locks").update({ locked_until: until }).eq("org_id", orgId).eq("lease_token", token).select("org_id");
        if (error || data?.length !== 1) throw Error("Organization lease lost");
        const renewal = await db.from("scoring_sync_events").update({ locked_until: until }).eq("org_id", orgId).eq("lease_token", token).eq("status", "running");
        if (renewal.error) throw Error("Event lease renewal failed");
      } catch { leaseError = true; }
      finally { renewing = false; }
    };
    const heartbeat = setInterval(() => { void renew(); }, 30_000);
    const successful: string[] = [];
    const failed: string[] = [];
    try {
      const sources = new Map();
      for (const id of new Set(events.map(e => e.data_source_id))) {
        const { data, error } = await db.from("data_sources").select("*").eq("id", id).eq("org_id", orgId).eq("source_type", "call_score").eq("is_active", true).single();
        if (error || !data) throw Error("Active scoring source unavailable");
        sources.set(id, data);
      }
      // Independent call identities have atomic per-document locks. Five calls
      // at once keeps this bounded while avoiding one slow embedding per batch.
      for (let i = 0; i < events.length; i += 5) {
        if (leaseError) throw Error("Lease renewal failed; refusing to acknowledge work");
        await Promise.all(events.slice(i, i + 5).map(async event => {
          try {
            await syncScoringRecord(db, sources.get(event.data_source_id), event.record_id);
            successful.push(event.id);
          } catch {
            failed.push(event.id);
          }
        }));
      }
      await renew();
      if (leaseError) throw Error("Lease renewal failed; refusing to acknowledge work");
      if (successful.length) {
        await rebuildCallScoreMetrics(db, orgId, { createdBy: "historical-backfill" });
        const { data, error } = await db.from("scoring_sync_events").update({ status: "completed", completed_at: new Date().toISOString(), last_error: null, locked_until: null })
          .eq("org_id", orgId).eq("status", "running").eq("lease_token", token).in("id", successful).select("id");
        if (error || data?.length !== successful.length) throw Error("Inbox acknowledgement failed");
        completed += successful.length;
      }
      console.log(JSON.stringify({ completed, batchSucceeded: successful.length, batchFailed: failed.length, at: new Date().toISOString() }));
    } finally {
      clearInterval(heartbeat);
      // This includes failures and any unacknowledged successes after an error.
      // New events arriving during the run have other IDs and are never touched.
      const retry = await db.from("scoring_sync_events").update({ status: "pending", next_attempt_at: new Date(Date.now() + 60_000).toISOString(), lease_token: null, locked_until: null, last_error: "Backfill refresh incomplete; retry scheduled" })
        .eq("org_id", orgId).eq("status", "running").eq("lease_token", token);
      const release = await db.from("scoring_sync_locks").delete().eq("org_id", orgId).eq("lease_token", token);
      if (retry.error || release.error) throw Error("Lease cleanup failed; automatic expiry will retry safely");
    }
    if (failed.length) throw Error("Some records failed; safe retries remain queued");
  }
  throw Error("Backfill deadline reached; outstanding work remains safely queued");
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
