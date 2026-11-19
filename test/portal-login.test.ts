import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { CookieOptions } from "@supabase/ssr";

const m = vi.hoisted(() => ({ service: vi.fn(), ssr: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: m.service }));
vi.mock("@/lib/ratelimit", () => ({ checkRateLimit: vi.fn(async () => ({ ok: true })) }));
vi.mock("@supabase/ssr", () => ({ createServerClient: m.ssr }));
import { GET as callback } from "@/app/auth/portal/callback/route";
import { GET as start } from "@/app/auth/portal/start/route";
import {
  readPortalConfig,
  normalizeOrigin,
  newState,
  newCodeVerifier,
  codeChallenge,
  encodeTxn,
  decodeTxn,
  txnCookieName,
  txnCookieOptions,
  redeemCode,
} from "@/lib/portal-login";
import { checkRateLimit } from "@/lib/ratelimit";

const ID = "ebe1c407-d28b-4e65-b787-25e7e8c44d74";
const OTHER = "7a063679-91fc-4525-8dd5-b06bd6e5a8e0";
const APP = "e2b93f8b-78df-4d57-b3f8-7d3213505871";
const account = {
  id: ID,
  email: "ceo@example.invalid",
  email_confirmed_at: "2026-01-01",
  banned_until: null,
};
const state = "s".repeat(43);
const verifier = "v".repeat(64);
const code = "c".repeat(43);
const env = {
  PORTAL_LOGIN_ENABLED: "true",
  CEO_PORTAL_ORIGIN: "https://ceo.example.invalid",
  AI_BRAIN_RAG_ORIGIN: "https://brain.example.invalid",
  CEO_PORTAL_APP_ID: APP,
  CEO_PORTAL_CLIENT_SECRET: "x".repeat(64),
  CEO_PORTAL_TARGET_USER_ID: ID,
  CEO_PORTAL_TARGET_ORG_ID: OTHER,
};
let auth: {
  getUser: ReturnType<typeof vi.fn>;
  verifyOtp: ReturnType<typeof vi.fn>;
  mfa: { getAuthenticatorAssuranceLevel: ReturnType<typeof vi.fn> };
};
let admin: {
  getUserById: ReturnType<typeof vi.fn>;
  generateLink: ReturnType<typeof vi.fn>;
  mfa: { listFactors: ReturnType<typeof vi.fn> };
};
let profile: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let setAll: (
  updates: { name: string; value: string; options: CookieOptions }[],
) => void;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ ok: true, limit:20, remaining:19, retryAfter:60 });
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubEnv("DEMO_MODE", "0");
  vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "0");
  vi.spyOn(console, "log").mockImplementation(() => {});
  profile = vi
    .fn()
    .mockResolvedValue({
      data: { user_id: ID, org_id: OTHER, role: "super_admin", is_active: true },
      error: null,
    });
  const chain = { select: () => chain, eq: () => chain, order: () => chain, limit: () => chain, maybeSingle: profile };
  admin = {
    mfa: { listFactors: vi.fn(async () => ({ data: { factors: [] }, error: null })) },
    getUserById: vi
      .fn()
      .mockResolvedValue({ data: { user: account }, error: null }),
    generateLink: vi
      .fn()
      .mockResolvedValue({
        data: {
          user: { id: ID },
          properties: { hashed_token: "server-only-hash" },
        },
        error: null,
      }),
  };
  m.service.mockReturnValue({ auth: { admin }, from: () => chain });
  auth = {
    getUser: vi
      .fn()
      .mockResolvedValue({ data: { user: account }, error: null })
      .mockResolvedValueOnce({
        data: { user: null },
        error: { name: "AuthSessionMissingError" },
      }),
    verifyOtp: vi.fn().mockImplementation(async () => {
      setAll([
        {
          name: "sb-test-auth-token",
          value: "native-session",
          options: { path: "/", sameSite: "lax" },
        },
      ]);
      return { data: { user: account }, error: null };
    }),
    mfa: {
      getAuthenticatorAssuranceLevel: vi
        .fn()
        .mockResolvedValue({
          data: { currentLevel: "aal1", nextLevel: "aal1" },
          error: null,
        }),
    },
  };
  m.ssr.mockImplementation((_url, _key, options) => {
    setAll = options.cookies.setAll;
    return { auth };
  });
  fetchMock = vi
    .fn()
    .mockResolvedValue(
      Response.json({
        version: 1,
        app_id: APP,
        target_user_id: ID,
        request_id: "test-request",
      }),
    );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function request(
  cookie = encodeTxn({ state, verifier }),
  url = "https://brain.example.invalid",
) {
  return new NextRequest(
    `${url}/auth/portal/callback?code=${code}&state=${state}`,
    {
      headers: cookie ? { cookie: `${txnCookieName(state)}=${cookie}` } : {},
    },
  );
}
async function refused() {
  const res = await callback(request());
  expect(res.headers.get("location")).toBe(
    "https://brain.example.invalid/login?portal_login_error=1",
  );
  expect(res.headers.get("set-cookie")).not.toContain("native-session");
  expect(res.cookies.get(txnCookieName(state))?.value).toBe("");
  return res;
}

describe("CEO Portal receiver", () => {
  it("mints a native session only for the configured active existing account, using the public destination", async () => {
    const res = await callback(request());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://brain.example.invalid/dashboard");
    expect(res.cookies.get("sb-test-auth-token")?.value).toBe("native-session");
    expect(res.cookies.get(txnCookieName(state))?.value).toBe("");
    expect(admin.getUserById).toHaveBeenCalledWith(ID);
    expect(admin.generateLink).toHaveBeenCalledWith({
      type: "magiclink",
      email: account.email,
    });
    expect(auth.verifyOtp).toHaveBeenCalledWith({
      type: "email",
      token_hash: "server-only-hash",
    });
    expect(profile).toHaveBeenCalledTimes(2);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it.each(["", "bad", encodeTxn({ state: "z".repeat(43), verifier })])(
    "rejects a missing, malformed or foreign transaction before redemption: %s",
    async (cookie) => {
      await callback(request(cookie));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(m.service).not.toHaveBeenCalled();
    },
  );
  it("refuses replay after the source has spent a code", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: "expired" }, { status: 409 }),
    );
    await refused();
    expect(m.service).not.toHaveBeenCalled();
  });
  it.each([
    { version: 2, app_id: APP, target_user_id: ID },
    { version: 1, app_id: OTHER, target_user_id: ID },
    { version: 1, app_id: APP, target_user_id: "bad" },
    { version: 1, app_id: APP, target_user_id: OTHER },
  ])("rejects foreign/malformed redemption %j", async (payload) => {
    fetchMock.mockResolvedValue(
      Response.json({ request_id: "test", ...payload }),
    );
    await refused();
    expect(m.service).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { ...account, id: OTHER },
    { ...account, email: null },
    { ...account, email_confirmed_at: null },
    { ...account, banned_until: "2099-01-01" },
  ])("rejects unavailable or blocked auth accounts", async (user) => {
    admin.getUserById.mockResolvedValue({ data: { user }, error: null });
    await refused();
    expect(admin.generateLink).not.toHaveBeenCalled();
  });
  it("fails closed on Auth lookup errors", async () => {
    admin.getUserById.mockResolvedValue({
      data: { user: account },
      error: { message: "outage" },
    });
    await refused();
    expect(admin.generateLink).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { user_id: ID, org_id: OTHER, role: "user", is_active: true },
    { user_id: ID, org_id: OTHER, role: "super_admin", is_active: false },
  ])("requires an active privileged profile", async (data) => {
    profile.mockResolvedValue({ data, error: null });
    await refused();
    expect(admin.generateLink).not.toHaveBeenCalled();
  });
  it("fails closed on profile read errors", async () => {
    profile.mockResolvedValue({
      data: { user_id: ID, org_id: OTHER, role: "super_admin", is_active: true },
      error: { message: "outage" },
    });
    await refused();
    expect(admin.generateLink).not.toHaveBeenCalled();
  });
  it("preserves another signed-in account without minting or replacing a session", async () => {
    auth.getUser
      .mockReset()
      .mockResolvedValue({ data: { user: { id: OTHER } }, error: null });
    await refused();
    expect(admin.generateLink).not.toHaveBeenCalled();
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });
  it("does not replace a session whose verification failed", async () => {
    auth.getUser
      .mockReset()
      .mockResolvedValue({
        data: { user: null },
        error: { name: "AuthRetryableFetchError" },
      });
    await refused();
    expect(admin.generateLink).not.toHaveBeenCalled();
  });
  it("reuses the same AAL2 session without downgrading or minting", async () => {
    auth.getUser
      .mockReset()
      .mockResolvedValue({ data: { user: account }, error: null });
    auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: "aal2", nextLevel: "aal2" },
      error: null,
    });
    const res = await callback(request());
    expect(res.headers.get("location")).toBe("https://brain.example.invalid/dashboard");
    expect(admin.generateLink).not.toHaveBeenCalled();
  });
  it("requires native sign-in for an enrolled factor before minting", async () => {
    admin.mfa.listFactors.mockResolvedValue({
      data: { factors: [{ status: "verified" }] }, error: null,
    });
    await refused();
    expect(admin.generateLink).not.toHaveBeenCalled();
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });
  it("rejects an MFA lookup failure", async () => {
    admin.mfa.listFactors.mockResolvedValue({ data: null, error: { message: "unavailable" } });
    await refused();
    expect(admin.generateLink).not.toHaveBeenCalled();
  });
  it("rejects an unverified second factor before committing cookies", async () => {
    auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: "aal1", nextLevel: "aal2" }, error: null,
    });
    await refused();
  });
  it("rejects the wrong active organization", async () => {
    profile.mockResolvedValue({ data: { user_id: ID, org_id: APP, role: "super_admin", is_active:true }, error: null });
    await refused();
    expect(admin.generateLink).not.toHaveBeenCalled();
  });
  it("rejects a request on a different destination origin", async () => {
    await callback(request(encodeTxn({state,verifier}), "https://other.example.invalid"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("fails closed when the durable rate limiter is unavailable", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ ok:false,limit:20,remaining:0,retryAfter:60 });
    await refused();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("discards staged cookies on MFA lookup failure", async () => {
    auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: null,
      error: { message: "unavailable" },
    });
    await refused();
  });
  it("refuses missing assurance levels instead of silently skipping MFA", async () => {
    auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: null, nextLevel: null }, error: null,
    });
    await refused();
  });
  it("rechecks account activation before committing cookies", async () => {
    profile
      .mockResolvedValueOnce({
        data: { user_id: ID, org_id: OTHER, role: "super_admin", is_active: true },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { user_id: ID, org_id: OTHER, role: "super_admin", is_active: false },
        error: null,
      });
    await refused();
  });
  it("refuses a generated token for a different account", async () => {
    admin.generateLink.mockResolvedValue({
      data: { user: { id: OTHER }, properties: { hashed_token: "wrong" } },
      error: null,
    });
    await refused();
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });
  it("discards session cookies if verification returns a different account", async () => {
    auth.verifyOtp.mockImplementation(async () => {
      setAll([
        { name: "sb-test-auth-token", value: "native-session", options: {} },
      ]);
      return { data: { user: { id: OTHER } }, error: null };
    });
    await refused();
  });
  it("reports connection failure without tokens or account details", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await refused();
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
      code,
    );
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
      env.CEO_PORTAL_CLIENT_SECRET,
    );
  });
  it("starts with distinct PKCE/state and secure cookie policy", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await start(
      new NextRequest(
        `https://brain.example.invalid/auth/portal/start?ticket=${code}`,
      ),
    );
    const destination = new URL(res.headers.get("location")!);
    const stored = res.cookies.get(
      txnCookieName(destination.searchParams.get("state")!),
    )!;
    const txn = decodeTxn(stored.value)!;
    expect(destination.origin).toBe(env.CEO_PORTAL_ORIGIN);
    expect(destination.pathname).toBe("/apps/connect/authorize");
    expect(destination.searchParams.get("code_challenge")).toBe(
      codeChallenge(txn.verifier),
    );
    expect(destination.searchParams.has("code_verifier")).toBe(false);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/);
    expect(res.headers.get("set-cookie")).toMatch(/Secure/);
    expect(res.headers.get("set-cookie")).toMatch(/SameSite=lax/i);
  });
});

describe("protocol primitives", () => {
  it("defaults to disabled and rejects demo mode, placeholders, unsafe origins and unknown targets", () => {
    expect(readPortalConfig({})).toMatchObject({ ok: false });
    for (const patch of [
      { DEMO_MODE: "1" },
      { NEXT_PUBLIC_DEMO_MODE: "1" },
      { CEO_PORTAL_APP_ID: "bad" },
      { CEO_PORTAL_CLIENT_SECRET: "short" },
      { CEO_PORTAL_TARGET_USER_ID: "bad" },
      { AI_BRAIN_RAG_ORIGIN: "https://brain.example.invalid/path" },
      { CEO_PORTAL_ORIGIN: "http://evil.test" },
    ])
      expect(readPortalConfig({ ...env, ...patch })).toMatchObject({
        ok: false,
      });
    expect(readPortalConfig(env)).toMatchObject({ ok: true });
  });
  it("allows explicit loopback only outside production", () => {
    expect(normalizeOrigin("http://localhost:3333", true)).toBe(
      "http://localhost:3333",
    );
    expect(normalizeOrigin("http://localhost:3333", false)).toBeNull();
    for (const url of [
      "https://a.test?x=1",
      "https://u:p@a.test",
      "http://192.168.1.1",
      "https://a.test/#x",
    ])
      expect(normalizeOrigin(url, true)).toBeNull();
  });
  it("creates independent random values and a correct RFC7636 challenge", () => {
    expect(newState()).not.toBe(newState());
    expect(newCodeVerifier()).not.toBe(newCodeVerifier());
    expect(codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    expect(txnCookieOptions(true)).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      maxAge: 300,
    });
  });
  it("redeems only server-to-server with the correct audience and no redirects", async () => {
    const config = readPortalConfig(env);
    if (!config.ok) throw Error("fixture");
    expect(await redeemCode(config.config, { code, verifier })).toMatchObject({
      ok: true,
      targetUserId: ID,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ceo.example.invalid/api/app-login/redeem",
      expect.objectContaining({
        redirect: "error",
        cache: "no-store",
        method: "POST",
      }),
    );
    const init = fetchMock.mock.calls[0][1];
    expect(JSON.parse(init.body)).toEqual({
      version: 1,
      app_id: APP,
      code,
      code_verifier: verifier,
    });
    expect(init.headers.Authorization).toBe(
      `Bearer ${env.CEO_PORTAL_CLIENT_SECRET}`,
    );
  });
});
