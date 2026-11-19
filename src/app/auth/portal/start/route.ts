import { NextResponse, type NextRequest } from "next/server";
import { checkRateLimit } from "@/lib/ratelimit";
import {
  NO_STORE_HEADERS,
  authorizeUrl,
  codeChallenge,
  encodeTxn,
  isOpaqueToken,
  newCodeVerifier,
  newState,
  readPortalConfig,
  safeLog,
  txnCookieName,
  txnCookieOptions,
} from "@/lib/portal-login";

/**
 * GET /auth/portal/start?ticket=…
 *
 * Step 2 of the login bridge. The portal has just minted a launch ticket and
 * sent the browser here. We mint our own PKCE pair, remember it in a cookie
 * only we can read, and bounce the browser to the portal's authorize endpoint.
 *
 * The ticket is opaque to us and we deliberately do not interpret it: only the
 * portal can say what it means. All we check is that it has the right shape, so
 * a malformed one is refused before it reaches the portal.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(request: NextRequest, code: string, status = 303) {
  const config = readPortalConfig();
  const url = new URL(
    "/login?portal_login_error=1",
    config.ok ? config.config.destinationOrigin : request.nextUrl.origin,
  );
  safeLog("start.refused", { reason: code });
  return NextResponse.redirect(url, { status, headers: NO_STORE_HEADERS });
}

export async function GET(request: NextRequest) {
  const config = readPortalConfig();
  if (!config.ok) {
    // Disabled is the default and is not an incident; a broken configuration is.
    safeLog("start.unavailable", { reason: config.reason });
    return fail(
      request,
      config.reason === "disabled" ? "disabled" : "misconfigured",
    );
  }

  if (request.nextUrl.origin !== config.config.destinationOrigin)
    return fail(request, "wrong_origin");

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = await checkRateLimit(`portal-start:${ip}`, 20);
  if (!limit.ok) return fail(request, "rate_limited");

  const ticket = request.nextUrl.searchParams.get("ticket");
  if (!isOpaqueToken(ticket)) {
    safeLog("start.bad_ticket");
    return fail(request, "bad_request");
  }

  const state = newState();
  const verifier = newCodeVerifier();

  const response = NextResponse.redirect(
    authorizeUrl(config.config, {
      ticket,
      state,
      challenge: codeChallenge(verifier),
    }),
    { status: 303, headers: NO_STORE_HEADERS },
  );

  // The verifier lives here and nowhere else - never in a URL, never in a log.
  response.cookies.set(
    txnCookieName(state),
    encodeTxn({ state, verifier }),
    txnCookieOptions(process.env.NODE_ENV === "production"),
  );

  safeLog("start.redirected");
  return response;
}
