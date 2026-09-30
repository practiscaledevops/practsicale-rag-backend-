import { describe, it, expect, vi, beforeEach } from "vitest";

// Access-config group-5 routes, gated through the REAL requireAdmin(): keys,
// connectors, prompts, settings, usage and playground. Unlike access-bulk-routes
// (which mocks requireAdmin to assert the key string), this file exercises the
// actual permission logic — getAdmin returns a member with a specific grants map,
// requireAdmin → hasPermission → hasAction decides, and we assert the HTTP status.
//
// It pins the product-owner rules for this group:
//   - destructive connectors DELETE (single + bulk) needs connectors:delete, NOT
//     connectors:write — a member who can register/grant connectors still cannot
//     tear grants down;
//   - keys DELETE keeps api_keys:revoke, separate from api_keys:write;
//   - every read GET needs "<resource>:read", and write/delete imply read, so the
//     back office is no longer readable by any active member (the flagged leak);
//   - super_admin bypasses all.
//
// Only getAdmin (the session source) and the Supabase client are mocked; the
// Supabase mock answers every query with an empty, non-error result so an
// authorized handler reaches a normal response instead of a 403.

type Perm = Record<string, string[]>;
type Session = {
  userId: string;
  orgId: string;
  email: string;
  role: "admin" | "super_admin";
  permissions: Perm;
  memberId: string;
};

const m = vi.hoisted(() => ({ getAdmin: vi.fn() }));

// Mock ONLY getAdmin; keep hasPermission (and hasAction it delegates to) real, so
// the read-implied-by-write rule is genuinely exercised, not stubbed.
vi.mock("@/lib/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/session")>()),
  getAdmin: m.getAdmin,
}));

// A permissive Supabase double: every terminal resolves to { data: [], error: null }
// so an authorized handler returns a normal 2xx/4xx (never a 403 from the DB layer).
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from() {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      const exec = () => Promise.resolve({ data: [], error: null });
      Object.assign(q, {
        select: chain,
        insert: chain,
        update: chain,
        upsert: chain,
        delete: chain,
        eq: chain,
        in: chain,
        is: chain,
        gte: chain,
        lte: chain,
        gt: chain,
        lt: chain,
        order: chain,
        limit: chain,
        range: chain,
        single: exec,
        maybeSingle: exec,
        then: (res: (v: { data: unknown; error: unknown }) => unknown, rej: (e: unknown) => unknown) =>
          exec().then(res, rej),
      });
      return q;
    },
  }),
}));

import { GET as keysGet, DELETE as keysDelete } from "@/app/api/admin/keys/route";
import { GET as connGet, POST as connPost, DELETE as connDelete } from "@/app/api/admin/connectors/route";
import { GET as promptsGet } from "@/app/api/admin/prompts/route";
import { GET as settingsGet } from "@/app/api/admin/settings/route";
import { GET as usageGet } from "@/app/api/admin/usage/route";
import { GET as playgroundGet } from "@/app/api/admin/playground/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const GRANT = id(1);

const session = (role: "admin" | "super_admin", permissions: Perm): Session => ({
  userId: "user-1",
  orgId: ORG,
  email: "member@practiscale.co",
  role,
  permissions,
  memberId: "member-1",
});
/** Point getAdmin at this session for the next handler call. */
const as = (role: "admin" | "super_admin", permissions: Perm = {}) => m.getAdmin.mockResolvedValue(session(role, permissions));

function req(url: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Read GETs — every section requires "<resource>:read"
// ---------------------------------------------------------------------------

describe("read GETs require the resource's read grant", () => {
  const cases: { label: string; resource: string; call: () => Promise<Response> }[] = [
    { label: "keys", resource: "api_keys", call: () => keysGet() },
    { label: "connectors", resource: "connectors", call: () => connGet() },
    { label: "prompts", resource: "prompts", call: () => promptsGet() },
    { label: "settings", resource: "settings", call: () => settingsGet() },
    { label: "usage/analytics", resource: "analytics", call: () => usageGet(req("/api/admin/usage?days=30", "GET")) },
    { label: "playground/documents", resource: "documents", call: () => playgroundGet() },
  ];

  it.each(cases)("403s on GET $label for a member without $resource read", async ({ resource, call }) => {
    // Holds an unrelated grant, but not this resource: must be refused.
    as("admin", { members: ["read"] });
    const res = await call();
    expect(res.status).toBe(403);
    void resource;
  });

  it.each(cases)("200s on GET $label for a member with $resource read", async ({ resource, call }) => {
    as("admin", { [resource]: ["read"] });
    expect((await call()).status).toBe(200);
  });

  it.each(cases)("200s on GET $label for a super_admin (bypass)", async ({ call }) => {
    as("super_admin");
    expect((await call()).status).toBe(200);
  });

  it("401s on GET when unauthenticated", async () => {
    m.getAdmin.mockResolvedValue(null);
    expect((await connGet()).status).toBe(401);
  });

  it("lets a connectors WRITER read connectors (read implied by write)", async () => {
    as("admin", { connectors: ["write"] });
    expect((await connGet()).status).toBe(200);
  });

  it("lets an analytics reader read usage but NOT settings", async () => {
    as("admin", { analytics: ["read"] });
    expect((await usageGet(req("/api/admin/usage?days=7", "GET"))).status).toBe(200);
    as("admin", { analytics: ["read"] });
    expect((await settingsGet()).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Destructive connectors DELETE — needs connectors:delete, not connectors:write
// ---------------------------------------------------------------------------

describe("DELETE /api/admin/connectors requires connectors:delete", () => {
  const single = () => connDelete(req(`/api/admin/connectors?grant_id=${GRANT}`, "DELETE"));
  const bulk = () => connDelete(req("/api/admin/connectors", "DELETE", { grant_ids: [GRANT] }));

  it("403s a write-but-not-delete member on the single path", async () => {
    as("admin", { connectors: ["read", "write"] });
    expect((await single()).status).toBe(403);
  });

  it("403s a write-but-not-delete member on the bulk path", async () => {
    as("admin", { connectors: ["read", "write"] });
    expect((await bulk()).status).toBe(403);
  });

  it("lets a connectors:delete holder through on both paths", async () => {
    as("admin", { connectors: ["read", "write", "delete"] });
    expect((await single()).status).not.toBe(403);
    as("admin", { connectors: ["read", "write", "delete"] });
    expect((await bulk()).status).not.toBe(403);
  });

  it("lets a super_admin through on both paths", async () => {
    as("super_admin");
    expect((await single()).status).not.toBe(403);
    as("super_admin");
    expect((await bulk()).status).not.toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Connectors POST (register / grant) — the write/curate path
// ---------------------------------------------------------------------------

describe("POST /api/admin/connectors is the write/curate path", () => {
  const create = () => connPost(req("/api/admin/connectors", "POST", { name: "Higgsfield", kind: "mcp", config: {} }));

  it("lets a connectors:write member create a connector (201, not 403)", async () => {
    as("admin", { connectors: ["read", "write"] });
    expect((await create()).status).toBe(201);
  });

  it("403s a read-only member creating a connector", async () => {
    as("admin", { connectors: ["read"] });
    expect((await create()).status).toBe(403);
  });

  it("lets a super_admin create a connector", async () => {
    as("super_admin");
    expect((await create()).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Keys DELETE — keeps api_keys:revoke, separate from api_keys:write
// ---------------------------------------------------------------------------

describe("DELETE /api/admin/keys requires api_keys:revoke (not write)", () => {
  const single = () => keysDelete(req(`/api/admin/keys?id=${id(5)}`, "DELETE"));
  const bulk = () => keysDelete(req("/api/admin/keys", "DELETE", { ids: [id(5)] }));

  it("403s a write-but-not-revoke member on the single path", async () => {
    as("admin", { api_keys: ["read", "write"] });
    expect((await single()).status).toBe(403);
  });

  it("403s a write-but-not-revoke member on the bulk path", async () => {
    as("admin", { api_keys: ["read", "write"] });
    expect((await bulk()).status).toBe(403);
  });

  it("lets an api_keys:revoke holder through on both paths", async () => {
    as("admin", { api_keys: ["revoke"] });
    expect((await single()).status).not.toBe(403);
    as("admin", { api_keys: ["revoke"] });
    expect((await bulk()).status).not.toBe(403);
  });

  it("lets a super_admin through on both paths", async () => {
    as("super_admin");
    expect((await single()).status).not.toBe(403);
    as("super_admin");
    expect((await bulk()).status).not.toBe(403);
  });
});
