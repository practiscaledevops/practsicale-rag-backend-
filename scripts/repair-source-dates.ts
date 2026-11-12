// Refresh source metadata only, preserving body revisions and deletion guards.
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
async function main() {
  const { supabaseAdmin } = await import("../src/lib/supabase");
  const { repairCallDates } = await import("../src/lib/connectors/repair-dates");
  const db = supabaseAdmin();
  const { data, error } = await db.from("data_sources").select("org_id").eq("slug","call-scoring").eq("is_active",true).single();
  if (error || !data) throw Error("Registered scoring source unavailable");
  console.log(JSON.stringify(await repairCallDates(data.org_id,db)));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
