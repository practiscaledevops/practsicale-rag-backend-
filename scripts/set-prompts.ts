// Publish the built-in prompt defaults as ACTIVE versions in the Prompt Studio,
// so the dashboard shows the current best prompts as the configured, editable
// versions (not just code fallbacks). Also lifts the answer-length cap so full
// content pieces (carousels, scripts, multi-part answers) are not truncated.
//
//   npm run set:prompts
//
// Idempotent: deactivates any prior versions per use-case, then inserts a fresh
// active version whose content equals the code default. Safe to re-run after the
// defaults in src/lib/prompts.ts change.

import { readFileSync } from "fs";

function loadEnvLocal(path = ".env.local"): void {
  let text: string;
  try { text = readFileSync(path, "utf-8"); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("="); if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvLocal();

const NEW_MAX_TOKENS = 4096; // generous ceiling for detailed answers + full content pieces

async function main() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("✖ Missing Supabase env"); process.exit(1);
  }
  const { supabaseAdmin } = await import("../src/lib/supabase");
  const { PROMPT_USE_CASES } = await import("../src/lib/prompts");
  const { loadSettings, saveSettings } = await import("../src/lib/settings");
  const db = supabaseAdmin();

  const { data: org } = await db
    .from("orgs").select("id, name").order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (!org) throw new Error("no org found — run setup:live first");
  const orgId = org.id as string;
  console.log(`• Org: ${org.name} (${orgId})`);

  for (const uc of PROMPT_USE_CASES) {
    await db.from("prompts").update({ is_active: false }).eq("org_id", orgId).eq("use_case", uc.key);
    const { data: maxRow } = await db
      .from("prompts").select("version").eq("org_id", orgId).eq("use_case", uc.key)
      .order("version", { ascending: false }).limit(1).maybeSingle();
    const version = ((maxRow as { version?: number } | null)?.version ?? 0) + 1;
    const { error } = await db.from("prompts").insert({
      org_id: orgId, use_case: uc.key, version, content: uc.default, is_active: true,
    });
    if (error) console.warn(`  (${uc.key}) ${error.message}`);
    else console.log(`✓ ${uc.label.padEnd(22)} active v${version} (${uc.default.length} chars)`);
  }

  // Lift the max answer length so detailed answers / content are not truncated.
  // Also nudge temperature up from 0 → 0.3 so richer, more natural prose comes
  // out of every model (esp. GPT + older Claude; the newest Claude models ignore
  // temperature). Grounding + citation rules keep it faithful.
  const NEW_TEMPERATURE = 0.3;
  const { settings } = await loadSettings(orgId, db);
  const next = {
    ...settings,
    generation: { ...settings.generation, maxTokens: NEW_MAX_TOKENS, temperature: NEW_TEMPERATURE },
  };
  await saveSettings(orgId, next, null, db);
  console.log(`✓ generation.maxTokens=${NEW_MAX_TOKENS} (was ${settings.generation.maxTokens}), temperature=${NEW_TEMPERATURE} (was ${settings.generation.temperature}).`);

  console.log("\nDone. Restart the Brain is NOT required (prompts + settings load from the DB per request).");
}

main().catch((e) => { console.error("✖ set-prompts failed:", e instanceof Error ? e.message : e); process.exit(1); });
