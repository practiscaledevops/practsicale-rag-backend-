// /api/admin/members — manage the org's admins/users.
//
// SECURITY: org_id is resolved SERVER-SIDE from the admin session (never from the
// request). Every read/write is filtered by that org, so a caller can only ever
// touch members of their own tenant.
//
//   GET    list members                         requireAdmin('members')
//   POST   invite/create an admin               super_admin only
//   PATCH  update permissions / role / active   requireAdmin('members');
//                                                role changes are super_admin only
//
// Creating a member provisions a Supabase Auth user (invite email) and inserts an
// org_members row that binds them to this org with a granular permission set.

import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
import type { Permissions } from "@/lib/auth/session";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

// The permission surface a super-admin can grant. Input is sanitized against
// this so an admin can never be granted an unknown resource/action.
const ALLOWED_PERMISSIONS: Record<string, string[]> = {
  data_sources: ["read", "write"],
  prompts: ["read", "write"],
  api_keys: ["read", "write", "revoke"],
  connectors: ["read", "write"],
  members: ["read", "write"],
  analytics: ["read"],
};

const MEMBER_COLUMNS = "id, email, role, permissions, is_active, user_id, created_at";

/** Keep only known resources/actions; drop everything else. */
function sanitizePermissions(input: unknown): Permissions {
  const out: Permissions = {};
  if (!input || typeof input !== "object") return out;
  for (const [resource, allowedActions] of Object.entries(ALLOWED_PERMISSIONS)) {
    const requested = (input as Record<string, unknown>)[resource];
    if (!Array.isArray(requested)) continue;
    const actions = allowedActions.filter((a) => requested.includes(a));
    if (actions.length > 0) out[resource] = actions;
  }
  return out;
}

function isValidEmail(email: unknown): email is string {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** GET — list this org's members. */
export async function GET() {
  let admin;
  try {
    admin = await requireAdmin("members");
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("org_members")
    .select(MEMBER_COLUMNS)
    .eq("org_id", admin.orgId)
    .order("created_at", { ascending: true });

  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({
    members: data ?? [],
    viewer: { memberId: admin.memberId, role: admin.role },
    allowedPermissions: ALLOWED_PERMISSIONS,
  });
}

/** POST — invite/create an admin. Super-admin only. */
export async function POST(req: Request) {
  let admin;
  try {
    admin = await requireAdmin("members");
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }
  // Only a super_admin may create admins (master plan §0.2, item 8).
  if (admin.role !== "super_admin") {
    return Response.json({ error: "Only a super_admin can create admins" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const email = body?.email;
  const role = body?.role === "super_admin" ? "super_admin" : "admin";
  const permissions = sanitizePermissions(body?.permissions);

  if (!isValidEmail(email)) {
    return Response.json({ error: "A valid email is required" }, { status: 400 });
  }

  const db = supabaseAdmin();

  // Provision the auth user via an invite (sends a set-password link). Requires
  // SMTP configured on the Supabase project.
  const { data: invited, error: inviteErr } = await db.auth.admin.inviteUserByEmail(email);
  if (inviteErr) {
    return Response.json({ error: `Could not invite user: ${inviteErr.message}` }, { status: 400 });
  }
  const userId = invited?.user?.id ?? null;

  const { data: member, error: insErr } = await db
    .from("org_members")
    .insert({
      org_id: admin.orgId,
      user_id: userId,
      email,
      role,
      permissions,
      created_by: admin.memberId,
    })
    .select(MEMBER_COLUMNS)
    .single();

  if (insErr) {
    // Unique (org_id, email) violation => already a member.
    const status = insErr.code === "23505" ? 409 : 500;
    const message =
      status === 409 ? "That email is already a member of this org" : insErr.message;
    return Response.json({ error: message }, { status });
  }

  return Response.json({ member }, { status: 201 });
}

/** PATCH — update a member's permissions, role, or active flag. */
export async function PATCH(req: Request) {
  let admin;
  try {
    // Mutating members (permissions / active flag / role) requires the WRITE
    // grant — not merely any presence on "members". Otherwise a member holding
    // only members:read could edit permissions (including their own) and
    // escalate privileges. Role changes are further restricted to super_admin
    // below.
    admin = await requireAdmin("members:write");
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  const body = await req.json().catch(() => ({}));
  const memberId = body?.memberId;
  if (typeof memberId !== "string" || !memberId) {
    return Response.json({ error: "memberId is required" }, { status: 400 });
  }

  const db = supabaseAdmin();

  // Load the target scoped to this org (prevents cross-tenant edits).
  const { data: target, error: findErr } = await db
    .from("org_members")
    .select("id, role")
    .eq("id", memberId)
    .eq("org_id", admin.orgId)
    .maybeSingle();
  if (findErr) return Response.json({ error: findErr.message }, { status: 500 });
  if (!target) return Response.json({ error: "Member not found" }, { status: 404 });

  const update: Record<string, unknown> = {};

  if (body?.permissions !== undefined) {
    update.permissions = sanitizePermissions(body.permissions);
  }

  if (typeof body?.is_active === "boolean") {
    if (memberId === admin.memberId && body.is_active === false) {
      return Response.json({ error: "You cannot deactivate yourself" }, { status: 400 });
    }
    update.is_active = body.is_active;
  }

  if (body?.role !== undefined) {
    // Role changes are super_admin-only, and you cannot change your own role
    // (prevents locking the last super_admin out).
    if (admin.role !== "super_admin") {
      return Response.json({ error: "Only a super_admin can change roles" }, { status: 403 });
    }
    if (memberId === admin.memberId) {
      return Response.json({ error: "You cannot change your own role" }, { status: 400 });
    }
    if (body.role !== "admin" && body.role !== "super_admin") {
      return Response.json({ error: "Invalid role" }, { status: 400 });
    }
    update.role = body.role;
  }

  if (Object.keys(update).length === 0) {
    return Response.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: member, error: updErr } = await db
    .from("org_members")
    .update(update)
    .eq("id", memberId)
    .eq("org_id", admin.orgId)
    .select(MEMBER_COLUMNS)
    .single();

  if (updErr) return Response.json({ error: updErr.message }, { status: 500 });
  return Response.json({ member });
}
