// Seed script: bootstrap the first org, its super-admin, and one scoped API key.
//
// Creates (idempotently where it can):
//   1. an org,
//   2. a Supabase Auth user for the super-admin (supabase.auth.admin.createUser),
//   3. an org_members row linking the user with role 'super_admin' + full perms,
//   4. ONE scoped api_key (full access) — printed ONCE in plaintext, then only a
//      hash is stored.
//
// Usage:  npm run seed
// Env (required):
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD
// Env (optional):
//   SEED_ORG_NAME   (default "Practiscale")
//
// The plaintext key cannot be recovered later; re-running mints a NEW key and
// prints it. The org / user / membership steps are idempotent.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generateApiKey } from "../src/lib/auth/keys";

// Full permission grant for a super-admin (also bypassed by role in code, but
// stored explicitly so the set is visible in the dashboard).
const FULL_PERMISSIONS = {
  data_sources: ["read", "write"],
  documents: ["read", "write"],
  prompts: ["read", "write"],
  api_keys: ["read", "write", "revoke"],
  connectors: ["read", "write"],
  collections: ["read", "write"],
  members: ["read", "write"],
  analytics: ["read"],
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "org";
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

async function main() {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const email = requireEnv("SEED_ADMIN_EMAIL");
  const password = requireEnv("SEED_ADMIN_PASSWORD");
  const orgName = process.env.SEED_ORG_NAME ?? "Practiscale";
  const orgSlug = slugify(orgName);

  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  // 1) Org (idempotent by slug).
  let orgId: string;
  const { data: existingOrg } = await db.from("orgs").select("id").eq("slug", orgSlug).maybeSingle();
  if (existingOrg) {
    orgId = existingOrg.id;
    console.log(`Org '${orgName}' already exists (${orgId}).`);
  } else {
    const { data: org, error } = await db
      .from("orgs")
      .insert({ name: orgName, slug: orgSlug })
      .select("id")
      .single();
    if (error || !org) throw new Error(`org insert failed: ${error?.message}`);
    orgId = org.id;
    console.log(`Created org '${orgName}' (${orgId}).`);
  }

  // 2) Supabase Auth user (idempotent: reuse if the email already exists).
  let userId: string;
  const { data: created, error: createErr } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    // org_id in app_metadata so a JWT hook can lift it into the org_id claim RLS uses.
    app_metadata: { org_id: orgId },
  });
  if (created?.user) {
    userId = created.user.id;
    console.log(`Created auth user ${email} (${userId}).`);
  } else {
    // Likely already registered — look it up.
    const found = await findUserByEmail(db, email);
    if (!found) throw new Error(`createUser failed and user not found: ${createErr?.message}`);
    userId = found;
    console.log(`Auth user ${email} already exists (${userId}).`);
  }

  // 3) org_members super-admin row (idempotent by (org_id, email)).
  const { data: member, error: memberErr } = await db
    .from("org_members")
    .upsert(
      {
        org_id: orgId,
        user_id: userId,
        email,
        role: "super_admin",
        permissions: FULL_PERMISSIONS,
        is_active: true,
      },
      { onConflict: "org_id,email" }
    )
    .select("id")
    .single();
  if (memberErr || !member) throw new Error(`org_members upsert failed: ${memberErr?.message}`);
  console.log(`Linked super-admin membership (${member.id}).`);

  // 4) ONE scoped API key with full access (empty scope arrays = no restriction).
  const key = generateApiKey("live");
  const { error: keyErr } = await db.from("api_keys").insert({
    org_id: orgId,
    name: "Seed super-admin key",
    key_prefix: key.prefix,
    key_hash: key.hash,
    source_types: [], // all source types
    capabilities: ["chat", "retrieve", "generate"],
    data_source_ids: [], // all sources
    collection_ids: [], // all collections
    created_by: member.id,
  });
  if (keyErr) throw new Error(`api_keys insert failed: ${keyErr.message}`);

  // ---- Print secrets ONCE ----
  console.log("\n============================================================");
  console.log("  SEED COMPLETE — save these now, they are shown ONCE.");
  console.log("============================================================");
  console.log(`  Org:        ${orgName} (${orgId})`);
  console.log(`  Login email:    ${email}`);
  console.log(`  Login password: ${password}`);
  console.log(`  API key:    ${key.secret}`);
  console.log(`  Key prefix: ${key.prefix}`);
  console.log("============================================================\n");
}

// Page through auth users to find one by email (admin API has no direct lookup).
async function findUserByEmail(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any, any, any>,
  email: string
): Promise<string | null> {
  const target = email.toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const match = data.users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (match) return match.id;
    if (data.users.length < 200) break; // last page
  }
  return null;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
