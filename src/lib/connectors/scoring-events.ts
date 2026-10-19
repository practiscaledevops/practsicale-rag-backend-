// Durable inbox worker. Per-org database leases prevent concurrent metrics
// rebuilds. Failures remain pending; the cron retries, including after a crash.
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { syncScoringRecord, type DataSourceRow } from "./pull";
import { rebuildCallScoreMetrics } from "@/lib/call-score-metrics";

export async function drainScoringEvents(deadlineAt = Date.now() + 230_000): Promise<number> {
  if (!process.env.SCORING_WEBHOOK_SECRET) return 0;
  const db = supabaseAdmin();
  let completed = 0;
  while (Date.now() < deadlineAt - 30_000) {
    const token = randomUUID();
    // One call per lease keeps a fresh status notification from waiting behind
    // a long bootstrap batch. New events are claimed before older backfill work.
    const { data, error } = await db.rpc("claim_scoring_sync_events", { p_token: token, p_limit: 1 });
    if (error) throw new Error(`Scoring inbox unavailable: ${error.message}`);
    const events = data as { id: string; org_id: string; data_source_id: string; record_id: string }[] | null;
    if (!events?.length) break;
    const ids = events.map(e => e.id);
    const orgId = events[0].org_id;
    try {
      for (const event of events) {
        if (Date.now() > deadlineAt - 30_000) throw new Error("Scoring refresh reached its time budget");
        const { data: source, error: sourceError } = await db.from("data_sources").select("*")
          .eq("id", event.data_source_id).eq("org_id", orgId).eq("source_type", "call_score").eq("is_active", true).maybeSingle();
        if (sourceError || !source) throw new Error("Call-scoring source is unavailable");
        await syncScoringRecord(db, source as DataSourceRow, event.record_id);
      }
      // Even an unchanged replay rebuilds metrics: the prior attempt may have
      // saved documents and crashed before updating the snapshot.
      await rebuildCallScoreMetrics(db, orgId, { createdBy: "scoring-webhook" });
      const { error: ackError } = await db.from("scoring_sync_events").update({ status: "completed", completed_at: new Date().toISOString(), last_error: null })
        .in("id", ids).eq("org_id", orgId).eq("lease_token", token);
      if (ackError) throw new Error(ackError.message);
      completed += events.length;
    } catch {
      // No call content or provider messages in the inbox's error column.
      await db.from("scoring_sync_events").update({ status: "pending", next_attempt_at: new Date(Date.now() + 60_000).toISOString(), last_error: "Refresh failed; retry scheduled" })
        .in("id", ids).eq("org_id", orgId).eq("lease_token", token);
      console.error("[scoring-sync] batch failed; retry scheduled");
      break;
    } finally {
      await db.from("scoring_sync_locks").delete().eq("org_id", orgId).eq("lease_token", token);
    }
  }
  return completed;
}
