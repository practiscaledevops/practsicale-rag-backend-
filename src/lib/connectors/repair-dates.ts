// One-time (idempotent) repair: align every stored call date with the scoring
// app. Two historical problems are fixed:
//   1. Recent records arrived with a BLANK call_date (the app leaves it empty and
//      shows created_at instead) — those calls fell into "no date".
//   2. Legacy call_score docs were ingested before dates were protected from PII
//      redaction, so their created_at/call_date became "[PHONE]".
//
// The canonical date is the UTC date of created_at (what the scoring app UI
// shows and always present). The scoring API is the source of truth for a clean
// created_at, matched to stored chunks/documents by source_record_id. Only date
// fields are touched; everything else in the metadata is preserved. Safe to run
// repeatedly.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase";
import { assertPublicUrl } from "@/lib/net-guard";
import { isAllowedSecretRef } from "@/lib/connectors/secret-ref";

const isoDatePart = (v: unknown): string | null => {
  const m = String(v ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};
/** A clean ISO timestamp, or null if it's absent or PII-mangled ("[PHONE]"). */
const cleanTs = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return /\[PHONE\]/.test(s) || !/^\d{4}-\d{2}-\d{2}T/.test(s) ? null : s;
};

export interface RepairResult {
  apiRecords: number;
  chunks: { scanned: number; fixed: number };
  documents: { scanned: number; fixed: number };
}

/** Build source_record_id -> clean created_at from the call-scoring API. */
async function loadCreatedAtMap(db: SupabaseClient, orgId: string): Promise<Map<string, string>> {
  const { data: source } = await db
    .from("data_sources")
    .select("endpoint_url, auth_secret_ref, records_path, record_id_field")
    .eq("source_type", "call_score")
    .eq("org_id", orgId)
    .limit(1)
    .maybeSingle();
  const s = source as {
    endpoint_url?: string;
    auth_secret_ref?: string;
    records_path?: string;
    record_id_field?: string;
  } | null;
  if (!s?.endpoint_url) throw new Error("no call_score data source / endpoint configured");
  await assertPublicUrl(s.endpoint_url);
  if (!s.auth_secret_ref || !isAllowedSecretRef(s.auth_secret_ref)) {
    throw new Error("call_score source has no allowed auth secret");
  }
  const key = process.env[s.auth_secret_ref];
  if (!key) throw new Error(`secret '${s.auth_secret_ref}' is empty`);
  const idField = s.record_id_field || "id";

  const map = new Map<string, string>();
  for (let offset = 0; offset < 50000; offset += 500) {
    const url = new URL(s.endpoint_url);
    url.searchParams.set("limit", "500");
    url.searchParams.set("offset", String(offset));
    const res = await fetch(url.toString(), {
      headers: { accept: "application/json", "x-api-key": key },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`scoring API ${res.status}`);
    const json = (await res.json()) as Record<string, unknown>;
    const recs = (s.records_path ? (json[s.records_path] as unknown[]) : (json.data as unknown[])) ?? [];
    const arr = Array.isArray(recs) ? recs : [];
    for (const r of arr as Record<string, unknown>[]) {
      const id = r[idField];
      if (id != null && r.created_at) map.set(String(id), String(r.created_at));
    }
    if (arr.length < 500) break;
  }
  return map;
}

export async function repairCallDates(orgId: string, dbArg?: SupabaseClient): Promise<RepairResult> {
  const db = dbArg ?? supabaseAdmin();
  const created = await loadCreatedAtMap(db, orgId);
  const result: RepairResult = {
    apiRecords: created.size,
    chunks: { scanned: 0, fixed: 0 },
    documents: { scanned: 0, fixed: 0 },
  };

  for (const table of ["chunks", "documents"] as const) {
    const bucket = result[table];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from(table)
        .select("id, metadata")
        .eq("org_id", orgId)
        .in("source_type", ["transcript", "call_score"])
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (error) throw new Error(`${table} read: ${error.message}`);
      const rows = (data ?? []) as { id: string; metadata: Record<string, unknown> }[];
      if (rows.length === 0) break;

      const pending: { id: string; metadata: Record<string, unknown> }[] = [];
      for (const row of rows) {
        bucket.scanned++;
        const m = row.metadata || {};
        const recId = m.source_record_id != null ? String(m.source_record_id) : null;
        const currentClean = cleanTs(m.created_at);
        const createdAt = currentClean || (recId ? created.get(recId) ?? null : null);
        const eff = isoDatePart(createdAt);
        if (!eff) continue; // unfixable (no clean created_at anywhere) — leave as-is
        const reported = isoDatePart(m.call_date);
        const next: Record<string, unknown> = { ...m, call_date: eff };
        if (createdAt && createdAt !== m.created_at) next.created_at = createdAt;
        if (reported && reported !== eff) next.reported_call_date = reported;
        const changed =
          m.call_date !== next.call_date ||
          next.created_at !== m.created_at ||
          (next.reported_call_date != null && m.reported_call_date !== next.reported_call_date);
        if (!changed) continue;
        pending.push({ id: row.id, metadata: next });
      }

      for (let i = 0; i < pending.length; i += 40) {
        const batch = pending.slice(i, i + 40);
        await Promise.all(
          batch.map((u) =>
            db
              .from(table)
              .update({ metadata: u.metadata })
              .eq("id", u.id)
              .eq("org_id", orgId)
              .then((r: { error: { message: string } | null }) => {
                if (r.error) throw new Error(`${table} ${u.id}: ${r.error.message}`);
              })
          )
        );
        bucket.fixed += batch.length;
      }
    }
  }
  return result;
}
