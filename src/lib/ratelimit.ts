// Per-key rate limiting for the public API.
//
// A fixed-window counter keyed by API key id, enforcing the key's own
// rate_limit_per_min. This is an IN-MEMORY limiter: it bounds abuse per running
// instance and is a real first line of defence, but it is not shared across
// serverless instances. For strict, distributed limits, back this with Upstash
// Redis (swap the Map for an INCR+EXPIRE) — the call site stays the same.
//
// Fail-open: any internal error never blocks a legitimate request.

interface Bucket {
  count: number;
  resetAt: number; // epoch ms when the window rolls over
}

const buckets = new Map<string, Bucket>();

// Opportunistic cleanup so the Map can't grow unbounded across many keys.
let lastSweep = 0;
function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets (for Retry-After). */
  retryAfter: number;
}

/**
 * Check-and-increment the caller's window. `limitPerMin <= 0` disables limiting.
 */
export function checkRateLimit(keyId: string, limitPerMin: number): RateLimitResult {
  const limit = Math.floor(limitPerMin);
  if (!keyId || !Number.isFinite(limit) || limit <= 0) {
    return { ok: true, limit: 0, remaining: 0, retryAfter: 0 };
  }

  try {
    const now = Date.now();
    sweep(now);
    let b = buckets.get(keyId);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + 60_000 };
      buckets.set(keyId, b);
    }
    b.count += 1;
    const remaining = Math.max(0, limit - b.count);
    const retryAfter = Math.ceil((b.resetAt - now) / 1000);
    return { ok: b.count <= limit, limit, remaining, retryAfter };
  } catch {
    return { ok: true, limit, remaining: 0, retryAfter: 0 };
  }
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
