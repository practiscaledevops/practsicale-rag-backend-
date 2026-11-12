// Use the same source-revision checks as webhooks; never invent occurrence dates.
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase";
import { repairSourceMetadata, type DataSourceRow } from "./pull";
export async function repairCallDates(orgId: string, dbArg?: SupabaseClient) {
  const db = dbArg ?? supabaseAdmin();
  const { data, error } = await db.from("data_sources").select("*").eq("org_id",orgId).eq("source_type","call_score").eq("is_active",true);
  if (error || !data?.length) throw Error("Active scoring source unavailable");
  let records = 0, documents = 0;
  for (const source of data as DataSourceRow[]) {
    const result = await repairSourceMetadata(db,source);
    records += result.records; documents += result.documents;
  }
  return { records, documents, dateBasis: "Source call dates and recorded CRM outcome dates" };
}
