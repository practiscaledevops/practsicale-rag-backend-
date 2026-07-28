// API key generation and hashing.
//
// A key looks like:  psk_live_<random>
// - The full secret is shown to the admin ONCE at creation and never stored.
// - We store only a SHA-256 hash and a short, non-secret prefix used to look the
//   key up quickly before a constant-time hash comparison.

import { createHash, randomBytes, timingSafeEqual } from "crypto";

const KEY_BYTES = 24; // 24 random bytes -> 48 hex chars of entropy

export interface GeneratedKey {
  /** The full secret. Return to the caller once; never persist. */
  secret: string;
  /** Non-secret identifier stored in the DB and shown in the UI. */
  prefix: string;
  /** SHA-256 of the full secret, stored in the DB. */
  hash: string;
}

/** Generate a new API key. `env` is a label only ("live" | "test"). */
export function generateApiKey(env: "live" | "test" = "live"): GeneratedKey {
  const random = randomBytes(KEY_BYTES).toString("hex");
  const secret = `psk_${env}_${random}`;
  return { secret, prefix: keyPrefix(secret), hash: hashApiKey(secret) };
}

/** SHA-256 hex of the full secret. */
export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** The stored, non-secret prefix (e.g. "psk_live_a1b2c3d4"). Safe to display. */
export function keyPrefix(secret: string): string {
  // psk_<env>_<random...> -> keep the scheme, env, and first 8 random chars.
  const parts = secret.split("_");
  if (parts.length < 3) return secret.slice(0, 16);
  const random = parts.slice(2).join("_");
  return `${parts[0]}_${parts[1]}_${random.slice(0, 8)}`;
}

/** Constant-time comparison of two hex hashes. */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
