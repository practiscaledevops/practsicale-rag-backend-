// Store a provider API key in the shared, ENCRYPTED provider_secrets table so
// EVERY Brain instance (local + deployed) resolves it without a redeploy or a
// Vercel env change. getProviderKey() resolves cache -> DB -> env, and the DB
// value wins, so once this runs, production picks the key up within ~30s.
//
//   npm run set:provider-key -- openai       (reads OPENAI_API_KEY from env)
//   npm run set:provider-key -- anthropic
//   npm run set:provider-key -- cohere
//
// Requires APP_SECRET to be the SAME value everywhere (it derives the encryption
// key). If prod's APP_SECRET differs, prod cannot decrypt this and falls back to
// its own env — in that case set the raw key in the Vercel env instead.

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

const ENV_FOR: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  cohere: "COHERE_API_KEY",
};

async function main() {
  const provider = (process.argv[2] || "openai").toLowerCase();
  if (!(provider in ENV_FOR)) {
    console.error(`✖ Unknown provider "${provider}". Use: openai | anthropic | cohere`);
    process.exit(1);
  }
  const key = process.env[ENV_FOR[provider]];
  if (!key || !key.trim()) {
    console.error(`✖ ${ENV_FOR[provider]} is not set in the environment / .env.local`);
    process.exit(1);
  }
  if (!process.env.APP_SECRET) {
    console.error("✖ APP_SECRET is not set — it is required to encrypt the key. It MUST match production.");
    process.exit(1);
  }

  const { setProviderKey, getProviderKey } = await import("../src/lib/secrets");
  await setProviderKey(provider as "openai" | "anthropic" | "cohere", key.trim(), null);
  const resolved = await getProviderKey(provider as "openai" | "anthropic" | "cohere");
  const ok = resolved === key.trim();
  console.log(
    `✓ Stored ${provider} key in provider_secrets (encrypted, last4 ${key.trim().slice(-4)}).` +
      `\n  Round-trip decrypt check: ${ok ? "OK" : "MISMATCH (check APP_SECRET)"}.` +
      `\n  Production will resolve it within ~30s (cache TTL) if its APP_SECRET matches.`
  );
}

main().catch((e) => { console.error("✖ set-provider-key failed:", e instanceof Error ? e.message : e); process.exit(1); });
