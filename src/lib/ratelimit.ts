import { supabaseAdmin } from "@/lib/supabase";

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets (for Retry-After). */
  retryAfter: number;
}


export async function checkRateLimit(keyId: string, limitPerMin: number): Promise<RateLimitResult> {
  const limit = Math.floor(limitPerMin);
  if (!keyId || !Number.isFinite(limit) || limit <= 0) return { ok: true, limit: 0, remaining: 0, retryAfter: 0 };
  const { data, error } = await supabaseAdmin().rpc("take_rate_slot", { p_scope: keyId, p_limit: limit });
  const ok = !error && typeof data === "number";
  return { ok, limit, remaining: ok ? Math.max(0, limit - data) : 0, retryAfter: 60 };
}

/** Standard rate-limit headers for a response. */
export function rateLimitHeaders(r: RateLimitResult): Record<string, string> {
  if (r.limit <= 0) return {};
  return {
    "x-ratelimit-limit": String(r.limit),
    "x-ratelimit-remaining": String(r.remaining),
    ...(r.ok ? {} : { "retry-after": String(r.retryAfter) }),
  };
}
