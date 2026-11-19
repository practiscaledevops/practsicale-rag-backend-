import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabase";
import { checkRateLimit } from "@/lib/ratelimit";
import {
  NO_STORE_HEADERS,
  decodeTxn,
  isOpaqueToken,
  readPortalConfig,
  redeemCode,
  safeLog,
  timingSafeEqualStr,
  txnCookieName,
  txnCookieOptions,
} from "@/lib/portal-login";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only a pre-existing, active, explicitly allowlisted account may be signed in.
 * Cookie writes are staged until every account/session/MFA check succeeds. */
export async function GET(request: NextRequest) {
  const config = readPortalConfig();
  const origin = config.ok
    ? config.config.destinationOrigin
    : request.nextUrl.origin;
  const state = request.nextUrl.searchParams.get("state");
  const cookieName = isOpaqueToken(state) ? txnCookieName(state) : null;
  const finish = (response: NextResponse) => {
    if (cookieName)
      response.cookies.set(cookieName, "", {
        ...txnCookieOptions(process.env.NODE_ENV === "production"),
        maxAge: 0,
      });
    return response;
  };
  const fail = (reason: string) => {
    safeLog("callback.refused", { reason });
    return finish(
      NextResponse.redirect(new URL("/login?portal_login_error=1", origin), {
        status: 303,
        headers: NO_STORE_HEADERS,
      }),
    );
  };
  if (!config.ok) return fail("unavailable");
  if (request.nextUrl.origin !== config.config.destinationOrigin)
    return fail("wrong_origin");
  const code = request.nextUrl.searchParams.get("code");
  if (!isOpaqueToken(code) || !isOpaqueToken(state) || !cookieName)
    return fail("bad_request");
  const txn = decodeTxn(request.cookies.get(cookieName)?.value);
  if (!txn || !timingSafeEqualStr(txn.state, state)) return fail("expired");

  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!(await checkRateLimit(`portal-callback:${ip}`, 20)).ok) return fail("rate_limited");
    const redeemed = await redeemCode(config.config, {
      code,
      verifier: txn.verifier,
    });
    if (!redeemed.ok) return fail(redeemed.reason);
    const targetId = redeemed.targetUserId;
    if (targetId !== config.config.targetUserId) return fail("not_authorised");
    const service = supabaseAdmin();
    const lookup = await service.auth.admin.getUserById(targetId);
    const account = lookup.data?.user;
    if (
      lookup.error ||
      !account ||
      account.id !== targetId ||
      !account.email ||
      !account.email_confirmed_at
    )
      return fail("no_account");
    if (
      account.banned_until &&
      (!Number.isFinite(Date.parse(account.banned_until)) ||
        Date.parse(account.banned_until) > Date.now())
    )
      return fail("no_account");
    if (account.app_metadata?.must_change_password)
      return fail("password_change_required");
    // Resolve the same earliest active membership as the native getAdmin().
    const activeProfile = async () => {
      const { data, error } = await service
        .from("org_members")
        .select("user_id, org_id, role, is_active")
        .eq("user_id", targetId)
        .eq("is_active", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      return (
        !error &&
        data?.is_active === true &&
        data.user_id === targetId &&
        data.org_id === config.config.orgId &&
        (data.role === "admin" || data.role === "super_admin")
      );
    };
    if (!(await activeProfile())) return fail("not_authorised");

    // SameSite=Lax native cookies arrive on this top-level callback. Read the
    // verified existing identity before minting anything; never switch accounts.
    const jar = new Map(
      request.cookies.getAll().map(({ name, value }) => [name, value]),
    );
    const outgoing: { name: string; value: string; options: CookieOptions }[] =
      [];
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookieOptions: {
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          path: "/",
        },
        cookies: {
          getAll: () => [...jar].map(([name, value]) => ({ name, value })),
          setAll: (
            updates: { name: string; value: string; options: CookieOptions }[],
          ) => {
            for (const update of updates) {
              jar.set(update.name, update.value);
              outgoing.push(update);
            }
          },
        },
      },
    );
    const current = await supabase.auth.getUser();
    if (current.error && current.error.name !== "AuthSessionMissingError")
      return fail("session_unavailable");
    if (current.data?.user && current.data.user.id !== targetId)
      return fail("session_mismatch");
    if (!current.data?.user) {
      const factors = await service.auth.admin.mfa.listFactors({ userId: targetId });
      if (factors.error || factors.data.factors.some((factor) => factor.status === "verified"))
        return fail("native_signin_required");

      // No email is sent. The hash stays server-side and must name the same UUID.
      const link = await service.auth.admin.generateLink({
        type: "magiclink",
        email: account.email,
      });
      const hash = link.data?.properties?.hashed_token;
      if (link.error || !hash || link.data?.user?.id !== targetId)
        return fail("signin_failed");
      const verified = await supabase.auth.verifyOtp({
        type: "email",
        token_hash: hash,
      });
      if (verified.error || verified.data?.user?.id !== targetId)
        return fail("signin_failed");
    }
    const settled = await supabase.auth.getUser();
    if (
      settled.error ||
      settled.data?.user?.id !== targetId ||
      !(await activeProfile())
    )
      return fail("session_unavailable");
    const assurance = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (
      assurance.error ||
      !assurance.data ||
      !["aal1", "aal2"].includes(assurance.data.currentLevel ?? "") ||
      !["aal1", "aal2"].includes(assurance.data.nextLevel ?? "")
    )
      return fail("assurance_unavailable");
    if (assurance.data.nextLevel === "aal2" && assurance.data.currentLevel !== "aal2")
      return fail("native_signin_required");
    const response = NextResponse.redirect(new URL("/dashboard", origin), {
      status: 303,
      headers: NO_STORE_HEADERS,
    });
    for (const { name, value, options } of outgoing)
      response.cookies.set(name, value, options);
    safeLog("callback.signed_in", {
      request_id: redeemed.requestId,
    });
    return finish(response);
  } catch {
    return fail("unavailable");
  }
}
