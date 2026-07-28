// Request authentication and org resolution.
//
// RULE (see CLAUDE.md): org_id is resolved HERE, server-side, from the API key
// hash — never from the request body. A client-supplied org_id would be a
// tenant-crossing hole.

import { supabaseAdmin } from "@/lib/supabase";
import { hashApiKey, keyPrefix, hashesEqual } from "./keys";

export type Capability = "chat" | "retrieve" | "generate";

export interface ApiKeyRecord {
  id: string;
  org_id: string;
  name: string | null;
  key_prefix: string | null;
  key_hash: string;
  source_types: string[];
  capabilities: Capability[];
  data_source_ids: string[];
  collection_ids: string[];
  rate_limit_per_min: number;
  expires_at: string | null;
  revoked_at: string | null;
  request_count: number;
}

export interface RequestContext {
  orgId: string;
  key: ApiKeyRecord;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

/** Extract the bearer secret from the Authorization header. */
function bearer(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    throw new AuthError("Missing or malformed Authorization header");
  }
  return token.trim();
}

/**
 * Resolve the request context from the API key.
 * Looks the key up by its non-secret prefix, then compares the hash in constant
 * time. Rejects revoked or expired keys. Returns the org and the key's scope.
 */
export async function resolveContext(req: Request): Promise<RequestContext> {
  const secret = bearer(req);
  if (!secret.startsWith("psk_")) throw new AuthError("Invalid API key");

  const db = supabaseAdmin();
  const prefix = keyPrefix(secret);

  const { data, error } = await db
    .from("api_keys")
    .select(
      "id, org_id, name, key_prefix, key_hash, source_types, capabilities, data_source_ids, collection_ids, rate_limit_per_min, expires_at, revoked_at, request_count"
    )
    .eq("key_prefix", prefix)
    .limit(2);

  if (error) throw new AuthError("Key lookup failed", 500);
  const candidates = (data ?? []) as ApiKeyRecord[];

  const providedHash = hashApiKey(secret);
  const key = candidates.find((k) => hashesEqual(k.key_hash, providedHash));
  if (!key) throw new AuthError("Invalid API key");

  if (key.revoked_at) throw new AuthError("API key has been revoked", 403);
  if (key.expires_at && new Date(key.expires_at) <= new Date()) {
    throw new AuthError("API key has expired", 403);
  }

  // Best-effort usage bump + last_used stamp. Never blocks the request.
  void db
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString(), request_count: key.request_count + 1 })
    .eq("id", key.id);

  return { orgId: key.org_id, key };
}
