import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/** A scoped, lightweight signal for inserts, updates and deletions. */
export async function documentRevision(db: SupabaseClient, orgId: string) {
  const { data, count, error } = await db.from("documents").select("id,updated_at", { count: "exact" })
    .eq("org_id", orgId).order("updated_at", { ascending: false }).order("id", { ascending: true }).limit(1);
  if (error || count == null) throw Error("Document revision unavailable");
  return createHash("sha256").update(JSON.stringify({ orgId, count, latest: data?.[0] ?? null })).digest("base64url");
}
