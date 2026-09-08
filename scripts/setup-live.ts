// One-command live bootstrap for the Brain.
//
//   npm run setup:live
//
// Idempotent. Reads real Supabase + provider creds from .env.local and:
//   1. ensures an org exists,
//   2. ensures a super-admin login (email/password) linked to that org,
//   3. registers the call-scoring PULL data source (with incremental `since`),
//   4. mints ONE scoped API key for the chatbot (chat + retrieve over call_score)
//      and prints the secret ONCE — copy it into the chatbot's BRAIN_API_KEY,
//   5. optionally runs a first backfill sync (SETUP_INITIAL_SYNC=1).
//
// Required env (.env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   SETUP_ADMIN_EMAIL, SETUP_ADMIN_PASSWORD, SCORING_API_KEY.
// Optional: SETUP_ORG_NAME (default "Practiscale"), SCORING_ENDPOINT,
//   SETUP_INITIAL_SYNC=1, SETUP_SYNC_LIMIT (default 500).

import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { generateApiKey } from "../src/lib/auth/keys";
import { runPull, type DataSourceRow } from "../src/lib/connectors/pull";

// Minimal .env.local loader (tsx doesn't auto-load it, and we avoid a dotenv dep).
// Only sets vars that aren't already in the environment.
function loadEnvLocal(path = ".env.local"): void {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return; // no file — rely on the ambient environment
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvLocal();

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL = process.env.SETUP_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.SETUP_ADMIN_PASSWORD;
const ORG_NAME = process.env.SETUP_ORG_NAME || "Practiscale";
const SCORING_ENDPOINT =
  process.env.SCORING_ENDPOINT || "https://scoring.practicescalingsystems.com/api/public/reports";
const SCORING_KEY = process.env.SCORING_API_KEY;
const DO_SYNC = process.env.SETUP_INITIAL_SYNC === "1";
const SYNC_LIMIT = process.env.SETUP_SYNC_LIMIT || "500";

function required(name: string, v: string | undefined): string {
  if (!v) {
    console.error(`✖ Missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

async function main() {
  required("NEXT_PUBLIC_SUPABASE_URL", URL);
  required("SUPABASE_SERVICE_ROLE_KEY", SERVICE);
  required("SETUP_ADMIN_EMAIL", ADMIN_EMAIL);
  required("SETUP_ADMIN_PASSWORD", ADMIN_PASSWORD);
  required("SCORING_API_KEY", SCORING_KEY);

  const db = createClient(URL!, SERVICE!, { auth: { persistSession: false } });

  // 1) Org ---------------------------------------------------------------
  let orgId: string;
  const { data: existingOrg } = await db.from("orgs").select("id").eq("name", ORG_NAME).maybeSingle();
  if (existingOrg?.id) {
    orgId = existingOrg.id as string;
    console.log(`• Org exists: ${ORG_NAME} (${orgId})`);
  } else {
    const { data, error } = await db.from("orgs").insert({ name: ORG_NAME }).select("id").single();
    if (error) throw new Error(`create org failed: ${error.message}`);
    orgId = data.id as string;
    console.log(`✓ Created org: ${ORG_NAME} (${orgId})`);
  }

  // 2) Super-admin auth user + membership --------------------------------
  let userId: string | null = null;
  const created = await db.auth.admin.createUser({
    email: ADMIN_EMAIL!,
    password: ADMIN_PASSWORD!,
    email_confirm: true,
  });
  if (created.data?.user) {
    userId = created.data.user.id;
    console.log(`✓ Created admin login: ${ADMIN_EMAIL}`);
  } else {
    // Already exists — find the user id by paging the admin list.
    for (let page = 1; page <= 20 && !userId; page++) {
      const { data } = await db.auth.admin.listUsers({ page, perPage: 200 });
      const match = data?.users.find((u) => u.email?.toLowerCase() === ADMIN_EMAIL!.toLowerCase());
      if (match) userId = match.id;
      if (!data || data.users.length < 200) break;
    }
    console.log(`• Admin login exists: ${ADMIN_EMAIL}`);
  }
  if (!userId) throw new Error("could not resolve admin user id");

  const { data: member } = await db
    .from("org_members")
    .select("id")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  let memberId: string;
  if (member?.id) {
    memberId = member.id as string;
    console.log("• Membership exists (super_admin)");
  } else {
    const { data, error } = await db
      .from("org_members")
      .insert({
        org_id: orgId,
        user_id: userId,
        email: ADMIN_EMAIL,
        role: "super_admin",
        permissions: {},
        is_active: true,
      })
      .select("id")
      .single();
    if (error) throw new Error(`create membership failed: ${error.message}`);
    memberId = data.id as string;
    console.log("✓ Created super_admin membership");
  }

  // 3) Call-scoring data source -----------------------------------------
  const slug = "call-scoring";
  const sourceConfig = {
    org_id: orgId,
    name: "Call Scoring",
    slug,
    source_type: "call_score",
    kind: "pull_http",
    endpoint_url: SCORING_ENDPOINT,
    http_method: "GET",
    auth_type: "api_key", // sent as x-api-key
    auth_secret_ref: "SCORING_API_KEY", // env var name holding the secret
    headers: {},
    query_params: { limit: SYNC_LIMIT },
    records_path: "data",
    record_id_field: "id",
    cursor_field: "created_at", // watermark read from each record
    cursor_param: "since", // sent to the API as ?since=<watermark>
    is_active: true,
    created_by: memberId,
    updated_at: new Date().toISOString(),
  };
  const { data: src, error: srcErr } = await db
    .from("data_sources")
    .upsert(sourceConfig, { onConflict: "org_id,slug" })
    .select("*")
    .single();
  if (srcErr) throw new Error(`upsert data source failed: ${srcErr.message}`);
  console.log(`✓ Registered data source: Call Scoring (${src.id})`);

  // 4) Scoped API key for the chatbot -----------------------------------
  const KEY_NAME = "chatbot";
  const { data: existingKey } = await db
    .from("api_keys")
    .select("id")
    .eq("org_id", orgId)
    .eq("name", KEY_NAME)
    .is("revoked_at", null)
    .maybeSingle();

  if (existingKey?.id) {
    console.log(`• Scoped key '${KEY_NAME}' already exists (not reprinting the secret).`);
  } else {
    const key = generateApiKey("live");
    const { error: keyErr } = await db.from("api_keys").insert({
      org_id: orgId,
      name: KEY_NAME,
      key_prefix: key.prefix,
      key_hash: key.hash,
      source_types: ["call_score"],
      capabilities: ["chat", "retrieve"],
      data_source_ids: [],
      collection_ids: [],
      rate_limit_per_min: 120,
      created_by: memberId,
    });
    if (keyErr) throw new Error(`create key failed: ${keyErr.message}`);
    console.log("\n──────────────────────────────────────────────");
    console.log("✓ Scoped key minted — copy into the chatbot's BRAIN_API_KEY:");
    console.log(`\n   ${key.secret}\n`);
    console.log("   (shown once, stored only as a hash)");
    console.log("──────────────────────────────────────────────\n");
  }

  // 5) Optional first backfill sync -------------------------------------
  if (DO_SYNC) {
    console.log("→ Running initial backfill sync (this calls the scoring API + embeds)…");
    const res = await runPull(src as DataSourceRow, { trigger: "manual", db });
    console.log(
      `✓ Sync ${res.status}: fetched ${res.recordsFetched}, ingested ${res.documentsIngested}, ` +
        `skipped ${res.documentsSkipped}, chunks ${res.chunksIngested}` +
        (res.error ? ` — ${res.error}` : "")
    );
  } else {
    console.log("• Skipped initial sync (set SETUP_INITIAL_SYNC=1 to backfill now, or use the dashboard).");
  }

  console.log("\n✓ Live setup complete.");
}

main().catch((e) => {
  console.error("✖ setup-live failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
