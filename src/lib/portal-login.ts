// Server only: CEO Portal protocol v1. Never import from a client component.
import crypto from "node:crypto";

export const PROTOCOL_VERSION = 1;

// Fixed by the contract. Not configurable: an endpoint that accepts a redirect
// target is an endpoint that can be pointed somewhere else.
export const START_PATH = "/auth/portal/start";
export const CALLBACK_PATH = "/auth/portal/callback";
const AUTHORIZE_PATH = "/apps/connect/authorize";
const REDEEM_PATH = "/api/app-login/redeem";

export const TXN_COOKIE_PREFIX = "rag_portal_txn_";
export const TXN_MAX_AGE_SECONDS = 300;
const REDEEM_TIMEOUT_MS = 10_000;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

// --- Configuration ----------------------------------------------------------

export interface PortalConfig {
  origin: string;
  destinationOrigin: string;
  appId: string;
  clientSecret: string;
  targetUserId: string;
  orgId: string;
}

export type ConfigResult =
  | { ok: true; config: PortalConfig }
  | { ok: false; reason: string };

/**
 * Reads and validates the server-only configuration.
 *
 * Disabled by default: with PORTAL_LOGIN_ENABLED unset, both routes behave as
 * if they do not exist. A half-configured bridge is worse than none, so every
 * value is checked here rather than at the point of use.
 */
export function readPortalConfig(
  env: Record<string, string | undefined> = process.env,
): ConfigResult {
  if (env.DEMO_MODE === "1" || env.NEXT_PUBLIC_DEMO_MODE === "1")
    return { ok: false, reason: "demo_disabled" };
  if (env.PORTAL_LOGIN_ENABLED !== "true")
    return { ok: false, reason: "disabled" };

  const origin = (env.CEO_PORTAL_ORIGIN ?? "").trim();
  const destinationOrigin = (env.AI_BRAIN_RAG_ORIGIN ?? "").trim();
  const appId = (env.CEO_PORTAL_APP_ID ?? "").trim();
  const clientSecret = (env.CEO_PORTAL_CLIENT_SECRET ?? "").trim();
  const targetUserId = (env.CEO_PORTAL_TARGET_USER_ID ?? "").trim();
  const orgId = (env.CEO_PORTAL_TARGET_ORG_ID ?? "").trim();
  if (!UUID.test(orgId)) return { ok: false, reason: "bad_org_id" };

  if (!origin || !appId || !clientSecret)
    return { ok: false, reason: "incomplete_config" };
  if (!UUID.test(targetUserId))
    return { ok: false, reason: "bad_target_user_id" };
  if (!UUID.test(appId)) return { ok: false, reason: "bad_app_id" };
  // A short secret is a typo or a placeholder, not a secret.
  if (clientSecret.length < 32) return { ok: false, reason: "weak_secret" };

  const normalized = normalizeOrigin(origin, env.NODE_ENV !== "production");
  if (!normalized) return { ok: false, reason: "bad_origin" };
  const destination = normalizeOrigin(
    destinationOrigin,
    env.NODE_ENV !== "production",
  );
  if (!destination) return { ok: false, reason: "bad_destination_origin" };

  return {
    ok: true,
    config: {
      origin: normalized,
      destinationOrigin: destination,
      appId,
      clientSecret,
      targetUserId,
      orgId,
    },
  };
}

/**
 * Exact origin, or null.
 *
 * Production is HTTPS only. Development additionally allows explicit loopback -
 * localhost, 127.0.0.1, [::1] - and nothing else: not a private LAN address,
 * not a .local name, not a tunnel host. No suffix matching and no wildcards,
 * because `https://evil-portal.example.com` must not match
 * `https://portal.example.com`.
 */
export function normalizeOrigin(
  value: string,
  allowLoopback: boolean,
): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // No path, query, fragment or credentials - an origin is scheme+host+port.
  if (
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    return null;

  const host = url.hostname.toLowerCase();
  const isLoopback =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]";

  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && allowLoopback && isLoopback)
    return url.origin;
  return null;
}

// --- PKCE -------------------------------------------------------------------

const base64url = (buf: Buffer) => buf.toString("base64url");

/** state: 32 bytes of entropy -> 43 base64url chars. */
export function newState(): string {
  return base64url(crypto.randomBytes(32));
}

/** code_verifier: RFC 7636 §4.1, 43-128 base64url chars. */
export function newCodeVerifier(): string {
  return base64url(crypto.randomBytes(64));
}

/** code_challenge = base64url(SHA-256(ascii(verifier))), unpadded. */
export function codeChallenge(verifier: string): string {
  return base64url(
    crypto.createHash("sha256").update(verifier, "ascii").digest(),
  );
}

/** 43-128 base64url characters, per the contract's shared shape. */
export function isOpaqueToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 43 &&
    value.length <= 128 &&
    BASE64URL.test(value)
  );
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Length-safe constant-time comparison. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// --- Transaction cookie -----------------------------------------------------

/**
 * One cookie per launch, named from the state.
 *
 * The app prefix keeps localhost cookies separate from other PractiScale apps.
 * The state-derived suffix keeps concurrent launches from overwriting each other.
 */
export function txnCookieName(state: string): string {
  return `${process.env.NODE_ENV === "production" ? "__Host-" : ""}${TXN_COOKIE_PREFIX}${state.slice(0, 12)}`;
}

export interface TxnPayload {
  state: string;
  verifier: string;
}

export function encodeTxn(payload: TxnPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeTxn(raw: string | undefined): TxnPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!isOpaqueToken(parsed?.state) || !isOpaqueToken(parsed?.verifier))
      return null;
    return { state: parsed.state, verifier: parsed.verifier };
  } catch {
    return null;
  }
}

export function txnCookieOptions(isProduction: boolean) {
  return {
    httpOnly: true,
    // SameSite=Lax so the cookie survives the portal's top-level redirect back.
    sameSite: "lax" as const,
    secure: isProduction,
    // The __Host- prefix prevents sibling domains from injecting a transaction.
    path: "/",
    maxAge: TXN_MAX_AGE_SECONDS,
  };
}

// --- Authorize redirect -----------------------------------------------------

export function authorizeUrl(
  config: PortalConfig,
  params: { ticket: string; state: string; challenge: string },
): string {
  const url = new URL(AUTHORIZE_PATH, config.origin);
  url.searchParams.set("app_id", config.appId);
  url.searchParams.set("ticket", params.ticket);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// --- Redemption -------------------------------------------------------------

export type RedeemResult =
  | { ok: true; targetUserId: string; requestId: string }
  // `reason` is for OUR logs and error page. It never carries portal detail
  // that would help someone probe the bridge.
  | {
      ok: false;
      reason: "unavailable" | "rejected" | "bad_response" | "app_mismatch";
      status?: number;
      portalError?: string;
    };

/**
 * Server-to-server redemption. The browser never sees this call.
 *
 * Fails closed on every uncertainty: a timeout, an unreachable portal or a
 * response that does not match the contract all mean "no login", never
 * "proceed anyway".
 */
export async function redeemCode(
  config: PortalConfig,
  params: { code: string; verifier: string },
  fetchImpl: typeof fetch = fetch,
): Promise<RedeemResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REDEEM_TIMEOUT_MS);

  let response: Response;
  let body: unknown;
  try {
    response = await fetchImpl(new URL(REDEEM_PATH, config.origin).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.clientSecret}`,
        Accept: "application/json",
      },
      body: JSON.stringify({
        version: PROTOCOL_VERSION,
        app_id: config.appId,
        code: params.code,
        code_verifier: params.verifier,
      }),
      signal: controller.signal,
      cache: "no-store",
      redirect: "error",
    });
    body = await response.json();
  } catch {
    return { ok: false, reason: "unavailable" };
  } finally {
    clearTimeout(timer);
  }

  const payload = (body ?? {}) as Record<string, unknown>;

  if (!response.ok) {
    const portalError =
      typeof payload.error === "string" ? payload.error : undefined;
    return {
      ok: false,
      reason: "rejected",
      status: response.status,
      portalError,
    };
  }

  if (payload.version !== PROTOCOL_VERSION)
    return { ok: false, reason: "bad_response", status: response.status };
  // The audience check: a response for a different app is not ours to act on,
  // however well-formed it looks.
  if (
    typeof payload.app_id !== "string" ||
    !timingSafeEqualStr(payload.app_id, config.appId)
  ) {
    return { ok: false, reason: "app_mismatch", status: response.status };
  }
  if (!isUuid(payload.target_user_id))
    return { ok: false, reason: "bad_response", status: response.status };
  if (
    typeof payload.request_id !== "string" ||
    payload.request_id.length === 0 ||
    payload.request_id.length > 128
  ) {
    return { ok: false, reason: "bad_response", status: response.status };
  }

  return {
    ok: true,
    targetUserId: payload.target_user_id,
    requestId: payload.request_id,
  };
}

// --- Logging ----------------------------------------------------------------

/**
 * The only identifier safe to log. Tickets, codes, verifiers, state and the
 * connection secret are never logged, in whole or in part - a prefix of a
 * 32-byte secret is still secret material, and a 60-second code is still live
 * while the log line is being written.
 */
export function safeLog(
  event: string,
  fields: Record<string, string | number | boolean | undefined> = {},
) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  console.log(
    `[portal-login] ${event}${parts.length ? " " + parts.join(" ") : ""}`,
  );
}

/** Headers every bridge response carries. */
export const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  Pragma: "no-cache",
} as const;
