import { describe, it, expect, vi, beforeEach } from "vitest";

// /api/admin/members — the access-control admin route. The session and Supabase
// are mocked so we can assert the security invariants without a DB:
//   - POST applies a preset and sanitizes/clamps the stored permissions
//   - a non-super-admin can never grant a permission they don't hold (no escalation)
//   - super_admin-only protections (invite, role change, editing a super_admin)
//   - GET returns the catalogue + presets the UI renders from
type Filter = [op: string, col: string, val: unknown];
interface Call {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  payload?: Record<string, unknown>;
  filters: Filter[];
}
type Result = { data: unknown; error: { message: string; code?: string } | null };

const m = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  create: vi.fn(),
  del: vi.fn(),
  calls: [] as Call[],
  respond: vi.fn<(call: Call) => Result | undefined>(),
}));

vi.mock("@/lib/auth/admin", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/admin")>()),
  requireAdmin: m.requireAdmin,
}));
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    auth: { admin: { createUser: m.create, deleteUser: m.del } },
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] };
      const exec = (): Promise<Result> => {
        m.calls.push(call);
        return Promise.resolve(m.respond(call) ?? { data: null, error: null });
      };
      const q: Record<string, unknown> = {};
      const filter = (op: string) => (col: string, val: unknown) => {
        call.filters.push([op, col, val]);
        return q;
      };
      Object.assign(q, {
        select: () => q,
        insert: (p: Record<string, unknown>) => ((call.op = "insert"), (call.payload = p), q),
        update: (p: Record<string, unknown>) => ((call.op = "update"), (call.payload = p), q),
        delete: () => ((call.op = "delete"), q),
        eq: filter("eq"),
        order: () => exec(),
        single: exec,
        maybeSingle: exec,
        then: (res: (v: Result) => unknown, rej: (e: unknown) => unknown) => exec().then(res, rej),
      });
      return q;
    },
  }),
}));

import { GET, POST, PATCH } from "@/app/api/admin/members/route";
import { presetById } from "@/lib/auth/permissions";

const ORG = "11111111-1111-4111-8111-111111111111";

type Session = { orgId: string; memberId: string; role: "admin" | "super_admin"; permissions: Record<string, string[]> };
const superAdmin: Session = { orgId: ORG, memberId: "self-super", role: "super_admin", permissions: {} };

function req(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/admin/members", {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const insertCall = () => m.calls.find((c) => c.table === "org_members" && c.op === "insert");
const updateCall = () => m.calls.find((c) => c.table === "org_members" && c.op === "update");

beforeEach(() => {
  vi.clearAllMocks();
  m.calls.length = 0;
  m.requireAdmin.mockResolvedValue(superAdmin);
  m.create.mockResolvedValue({ data: { user: { id: "new-auth-user" } }, error: null });
  m.del.mockResolvedValue({ data: null, error: null });
  m.respond.mockImplementation((call) => {
    if (call.op === "insert") return { data: { id: "m-new", ...call.payload }, error: null };
    if (call.op === "update") return { data: { id: "target", ...call.payload }, error: null };
    return undefined;
  });
});

describe("GET /api/admin/members", () => {
  it("returns the catalogue and presets for the UI", async () => {
    m.respond.mockImplementation((call) => (call.op === "select" ? { data: [], error: null } : undefined));
    const json = await (await GET()).json();
    expect(Array.isArray(json.catalogue)).toBe(true);
    expect(json.catalogue.some((r: { id: string }) => r.id === "documents")).toBe(true);
    expect(json.presets.map((p: { id: string }) => p.id)).toContain("knowledge_uploader");
    expect(json.viewer.role).toBe("super_admin");
  });
});

describe("POST /api/admin/members — create", () => {
  const PW = "s3cret-pw-123";

  it("applies the Knowledge uploader preset by id and creates the user with the given password (no email sent)", async () => {
    const res = await POST(req("POST", { email: "saleh@practiscale.co", password: PW, preset: "knowledge_uploader" }));
    expect(res.status).toBe(201);
    expect(insertCall()?.payload?.permissions).toEqual(presetById("knowledge_uploader")!.permissions);
    expect(insertCall()?.payload?.org_id).toBe(ORG);
    // Account created directly, already confirmed — never invited by email.
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ email: "saleh@practiscale.co", password: PW, email_confirm: true }));
  });

  it("rejects a missing or too-short password before creating the user", async () => {
    const short = await POST(req("POST", { email: "a@practiscale.co", password: "short" }));
    expect(short.status).toBe(400);
    const none = await POST(req("POST", { email: "a@practiscale.co" }));
    expect(none.status).toBe(400);
    expect(m.create).not.toHaveBeenCalled();
    expect(insertCall()).toBeUndefined();
  });

  it("returns 409 when the email already has an account", async () => {
    m.create.mockResolvedValue({ data: null, error: { message: "A user with this email address has already been registered" } });
    const res = await POST(req("POST", { email: "dup@practiscale.co", password: PW, preset: "knowledge_uploader" }));
    expect(res.status).toBe(409);
    expect(insertCall()).toBeUndefined();
  });

  it("rolls back the auth user when the org_members insert fails", async () => {
    m.respond.mockImplementation((call) => {
      if (call.op === "insert") return { data: null, error: { code: "23505", message: "duplicate" } };
      return undefined;
    });
    const res = await POST(req("POST", { email: "again@practiscale.co", password: PW, preset: "knowledge_uploader" }));
    expect(res.status).toBe(409);
    expect(m.del).toHaveBeenCalledWith("new-auth-user");
  });

  it("sanitizes explicit permissions (drops delete on data_sources and unknown keys)", async () => {
    await POST(
      req("POST", {
        email: "x@practiscale.co",
        password: PW,
        permissions: { documents: ["read", "write", "nuke"], data_sources: ["read", "delete"], bogus: ["read"] },
      })
    );
    expect(insertCall()?.payload?.permissions).toEqual({ documents: ["read", "write"], data_sources: ["read"] });
  });

  it("stores no permissions map for a super_admin invite", async () => {
    await POST(req("POST", { email: "owner@practiscale.co", password: PW, role: "super_admin", permissions: { documents: ["read"] } }));
    expect(insertCall()?.payload?.permissions).toEqual({});
    expect(insertCall()?.payload?.role).toBe("super_admin");
  });

  it("rejects a non-super-admin", async () => {
    m.requireAdmin.mockResolvedValue({ ...superAdmin, role: "admin", permissions: { members: ["read", "write"] } });
    const res = await POST(req("POST", { email: "y@practiscale.co", password: PW, preset: "knowledge_uploader" }));
    expect(res.status).toBe(403);
    expect(insertCall()).toBeUndefined();
  });

  it("rejects an invalid email before creating the user", async () => {
    const res = await POST(req("POST", { email: "not-an-email", password: PW }));
    expect(res.status).toBe(400);
    expect(m.create).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admin/members — no escalation", () => {
  const nonSuper: Session = {
    orgId: ORG,
    memberId: "self-admin",
    role: "admin",
    permissions: { documents: ["read", "write"], members: ["read", "write"] },
  };

  it("clamps a non-super-admin's grant to what they hold", async () => {
    m.requireAdmin.mockResolvedValue(nonSuper);
    // Target is a normal admin.
    m.respond.mockImplementation((call) => {
      if (call.op === "select") return { data: { id: "target", role: "admin" }, error: null };
      if (call.op === "update") return { data: { id: "target", ...call.payload }, error: null };
      return undefined;
    });
    await PATCH(
      req("PATCH", { memberId: "target", permissions: { documents: ["read", "write", "delete"], connectors: ["read"] } })
    );
    // delete dropped (granter lacks it); connectors dropped entirely (not held).
    expect(updateCall()?.payload?.permissions).toEqual({ documents: ["read", "write"] });
  });

  it("lets a super_admin grant anything (delete included)", async () => {
    m.respond.mockImplementation((call) => {
      if (call.op === "select") return { data: { id: "target", role: "admin" }, error: null };
      if (call.op === "update") return { data: { id: "target", ...call.payload }, error: null };
      return undefined;
    });
    await PATCH(req("PATCH", { memberId: "target", permissions: { documents: ["read", "write", "delete"] } }));
    expect(updateCall()?.payload?.permissions).toEqual({ documents: ["read", "write", "delete"] });
  });

  it("forbids a non-super-admin from editing a super_admin", async () => {
    m.requireAdmin.mockResolvedValue(nonSuper);
    m.respond.mockImplementation((call) =>
      call.op === "select" ? { data: { id: "target", role: "super_admin" }, error: null } : undefined
    );
    const res = await PATCH(req("PATCH", { memberId: "target", permissions: { documents: ["read"] } }));
    expect(res.status).toBe(403);
    expect(updateCall()).toBeUndefined();
  });

  it("forbids a non-super-admin from changing roles", async () => {
    m.requireAdmin.mockResolvedValue(nonSuper);
    m.respond.mockImplementation((call) =>
      call.op === "select" ? { data: { id: "target", role: "admin" }, error: null } : undefined
    );
    const res = await PATCH(req("PATCH", { memberId: "target", role: "super_admin" }));
    expect(res.status).toBe(403);
  });

  it("applies a preset on PATCH too (sanitized + clamped)", async () => {
    m.respond.mockImplementation((call) => {
      if (call.op === "select") return { data: { id: "target", role: "admin" }, error: null };
      if (call.op === "update") return { data: { id: "target", ...call.payload }, error: null };
      return undefined;
    });
    await PATCH(req("PATCH", { memberId: "target", preset: "operator_admin" }));
    expect(updateCall()?.payload?.permissions).toEqual(presetById("operator_admin")!.permissions);
  });
});
