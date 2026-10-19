// Read-only inspection; prints schema/config/status summaries, never call text or keys.
import { loadEnvConfig } from "@next/env";
import { createClient } from "@supabase/supabase-js";
loadEnvConfig(process.cwd());
async function main() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: sources, error } = await db.from("data_sources").select("id,org_id,name,source_type,endpoint_url,query_params,records_path,record_id_field,cursor_field,cursor_param,cursor_value,last_status,last_run_at,schedule_cron,auth_secret_ref,auth_type").eq("source_type", "call_score");
  if (error) throw new Error(error.message);
  for (const s of sources ?? []) {
    console.log(JSON.stringify({ source: s.name, endpoint: s.endpoint_url, cursorField: s.cursor_field, cursorParam: s.cursor_param, cursor: s.cursor_value, lastStatus: s.last_status, lastRun: s.last_run_at, queryParams: s.query_params, schedule: s.schedule_cron }));
    const url = new URL(s.endpoint_url);
    url.searchParams.set("limit", "10"); url.searchParams.set("include_transcript", "false");
    const res = await fetch(url, { headers: { "x-api-key": process.env[s.auth_secret_ref] ?? "" }, signal: AbortSignal.timeout(30_000) });
    const body = await res.json();
    const records = (s.records_path ? s.records_path.split(".").reduce((o: any, k: string) => o?.[k], body) : body) as any[];
    console.log(JSON.stringify({ scoringStatus: res.status, fields: Object.keys(records?.[0] ?? {}), records: records?.length, statuses: [...new Set(records?.map(r => r.call_status))], outcomes: [...new Set(records?.map(r => r.call_outcome))], prospectTypes: [...new Set(records?.map(r => r.prospect_type))], hasUpdatedAt: records?.some(r => r.updated_at) }));
    const { data: docs } = await db.from("documents").select("id,source_type,metadata,created_at").eq("org_id", s.org_id).eq("data_source_id", s.id).range(0, 9999);
    const groups = new Map<string, any[]>();
    for (const d of docs ?? []) { const id = d.metadata?.source_record_id; if (!id) continue; const key = d.source_type + ":" + id; groups.set(key, [...(groups.get(key) ?? []), d]); }
    console.log(JSON.stringify({ storedDocuments: docs?.length, duplicateRecordGroups: [...groups.values()].filter(g => g.length > 1).length,
      latestSampleMismatches: (records ?? []).filter(r => { const saved = groups.get("call_score:" + r[s.record_id_field])?.at(-1)?.metadata; return saved && ["call_status", "call_outcome", "overall_score", "prospect_type"].some(k => (saved[k] ?? null) !== (r[k] ?? null)); }).length }));
    const { data: runs } = await db.from("ingestion_runs").select("status,started_at,finished_at,documents_ingested,documents_skipped,error").eq("data_source_id", s.id).order("started_at", { ascending: false }).limit(3);
    console.log(JSON.stringify({ recentRuns: runs }));
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
