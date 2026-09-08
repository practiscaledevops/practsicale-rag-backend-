// Provider API-key store — lets a super-admin set/rotate OpenAI, Anthropic, and
// Cohere keys from the dashboard instead of via env + redeploy.
//
// - Keys are stored ENCRYPTED (AES-256-GCM, key derived from APP_SECRET) in the
//   global `provider_secrets` table, read only through the service-role client.
// - getProviderKey(provider) resolves: in-process cache → DB (decrypted) → env.
//   So the app works with either source, and the DB value overrides env once set.
// - The plaintext secret NEVER leaves the server; the API surface returns only a
//   masked status (configured?, last4, source).
//
// Server-only.

import { createHash, createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { isDemo } from "@/lib/demo/mode";

export type Provider = "openai" | "anthropic" | "cohere";
export const PROVIDERS: Provider[] = ["openai", "anthropic", "cohere"];

const ENV_VAR: Record<Provider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  cohere: "COHERE_API_KEY",
};

// ---- encryption -----------------------------------------------------------

function encKey(): Buffer {
  const secret = process.env.APP_SECRET || "insecure-dev-secret-change-me";
  // Derive a 32-byte key deterministically from APP_SECRET.
  return scryptSync(secret, "provider-secrets-v1", 32);
}

function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${data.toString("base64")}`;
}

function decrypt(blob: string): string | null {
  try {
    const [ivB64, tagB64, dataB64] = blob.split(":");
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const decipher = createDecipheriv("aes-256-gcm", encKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const out = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
    return out.toString("utf8");
  } catch {
    return null; // wrong APP_SECRET / corrupt blob → treat as unset
  }
}

// ---- resolution (cache → DB → env) ----------------------------------------

interface CacheEntry {
  value: string | null;
  at: number;
}
const cache = new Map<Provider, CacheEntry>();
const TTL_MS = 30_000; // short TTL so a UI key change takes effect promptly

/** Resolve a provider's key: in-process cache → DB (decrypted) → env var. */
export async function getProviderKey(provider: Provider): Promise<string | undefined> {
  const now = Date.now();
  const hit = cache.get(provider);
  if (hit && now - hit.at < TTL_MS) return hit.value ?? envKey(provider);

  let value: string | null = null;
  if (!isDemo()) {
    try {
      const { data } = await supabaseAdmin()
        .from("provider_secrets")
        .select("ciphertext")
        .eq("provider", provider)
        .maybeSingle();
      const ct = (data as { ciphertext?: string } | null)?.ciphertext;
      if (ct) value = decrypt(ct);
    } catch {
      /* fall through to env */
    }
  }
  cache.set(provider, { value, at: now });
  return value ?? envKey(provider);
}

function envKey(provider: Provider): string | undefined {
  const v = process.env[ENV_VAR[provider]];
  return v && v.trim() ? v : undefined;
}

/** Invalidate the in-process cache for a provider (after a write). */
export function bustProviderCache(provider?: Provider): void {
  if (provider) cache.delete(provider);
  else cache.clear();
}

// ---- admin operations -----------------------------------------------------

export interface ProviderStatus {
  provider: Provider;
  configured: boolean;
  /** where the active value comes from */
  source: "db" | "env" | "none";
  last4: string | null;
  updatedAt: string | null;
}

/** Masked status for every provider (never returns the secret itself). */
export async function listProviderStatus(): Promise<ProviderStatus[]> {
  let rows: Record<string, { last4: string | null; updated_at: string | null }> = {};
  if (!isDemo()) {
    try {
      const { data } = await supabaseAdmin()
        .from("provider_secrets")
        .select("provider, last4, updated_at");
      for (const r of (data ?? []) as { provider: string; last4: string | null; updated_at: string | null }[]) {
        rows[r.provider] = { last4: r.last4, updated_at: r.updated_at };
      }
    } catch {
      rows = {};
    }
  }
  return PROVIDERS.map((provider) => {
    const db = rows[provider];
    if (db) {
      return { provider, configured: true, source: "db", last4: db.last4, updatedAt: db.updated_at };
    }
    if (envKey(provider)) {
      const v = envKey(provider)!;
      return { provider, configured: true, source: "env", last4: v.slice(-4), updatedAt: null };
    }
    return { provider, configured: false, source: "none", last4: null, updatedAt: null };
  });
}

/** Set/rotate a provider key (encrypted at rest). */
export async function setProviderKey(
  provider: Provider,
  secret: string,
  updatedBy: string | null
): Promise<void> {
  const clean = secret.trim();
  if (!clean) throw new Error("secret is empty");
  await supabaseAdmin()
    .from("provider_secrets")
    .upsert(
      {
        provider,
        ciphertext: encrypt(clean),
        last4: clean.slice(-4),
        updated_at: new Date().toISOString(),
        updated_by: updatedBy,
      },
      { onConflict: "provider" }
    );
  bustProviderCache(provider);
}

/** Remove a provider key from the DB (falls back to env afterwards). */
export async function deleteProviderKey(provider: Provider): Promise<void> {
  await supabaseAdmin().from("provider_secrets").delete().eq("provider", provider);
  bustProviderCache(provider);
}

/** Stable fingerprint of the resolved key set — handy for cache-busting elsewhere. */
export async function providerKeyFingerprint(): Promise<string> {
  const keys = await Promise.all(PROVIDERS.map((p) => getProviderKey(p)));
  return createHash("sha256").update(keys.map((k) => k ?? "").join("|")).digest("hex").slice(0, 12);
}
