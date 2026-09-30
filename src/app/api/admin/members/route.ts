// /api/admin/members — manage the org's admins/users.
//
// SECURITY: org_id is resolved SERVER-SIDE from the admin session (never from the
// request). Every read/write is filtered by that org, so a caller can only ever
// touch members of their own tenant.
//
//   GET    list members                         requireAdmin('members')
//   POST   create a member (email + password)    super_admin only
//   PATCH  update permissions / role / active   requireAdmin('members:write');
//                                                role changes are super_admin only
//
// Creating a member provisions a Supabase Auth user with the password the
// super-admin sets (email pre-confirmed — no invite email) and inserts an
// org_members row binding them to this org with a granular permission set. The
// member can change their own password later from their profile. The raw
// password is used once to create the account and is never stored or logged.
//
// The grantable surface + sanitize + presets all derive from the permission
// CATALOGUE (src/lib/auth/permissions.ts) — the single source of truth the Admins
// UI also renders from. Add a resource/action there and it appears here for free.

import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
import {
  GRANTABLE_PERMISSIONS,
  PERMISSION_CATALOGUE,
  PRESETS,
  clampToGranter,
  presetById,
  sanitizePermissions,
  MIN_PASSWORD_LENGTH,
} from "@/lib/auth/permissions";
import type { AdminSession, Permissions } from "@/lib/auth/session";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

const MEMBER_COLUMNS = "id, email, role, permissions, is_active, user_id, created_at";

function isValidEmail(email: unknown): email is string {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Resolve the permission set to store from the request: an explicit permissions
 * map wins; otherwise an optional preset id fills it. The result is sanitized to
 * the catalogue surface AND clamped to what the granter themselves holds, so a
 * non-super-admin can never grant a permission they lack (super_admin passes all).
 */
function resolvePermissions(body: Record<string, unknown>, granter: AdminSession): Permissions {
  let raw: unknown = body?.permissions;
  if (raw === undefined && typeof body?.preset === "string") {
    raw = presetById(body.preset)?.permissions;
  }
  return clampToGranter(sanitizePermissions(raw), granter);
}

/** GET — list this org's members, plus the catalogue + presets the UI renders from. */
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
    viewer: { memberId: admin.memberId, role: admin.role, permissions: admin.permissions },
    catalogue: PERMISSION_CATALOGUE,
    presets: PRESETS,
    // Retained for compatibility; the UI now renders from `catalogue`.
    allowedPermissions: GRANTABLE_PERMISSIONS,
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
  const password = body?.password;
  const role = body?.role === "super_admin" ? "super_admin" : "admin";
  // Super admins carry all access via the role; don't also store a permissions map.
  const permissions = role === "super_admin" ? {} : resolvePermissions(body, admin);

  if (!isValidEmail(email)) {
    return Response.json({ error: "A valid email is required" }, { status: 400 });
  }
  // The super-admin SETS the member's password here (internal tool — no invite
  // email). The member can change it later from their profile. The raw value is
  // used once to create the auth user and is never stored or logged.
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return Response.json(
      { error: `Set a password of at least ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 }
    );
  }

  const db = supabaseAdmin();

  // Create the auth user with the given password, already confirmed (no email
  // sent). A duplicate email surfaces as a clear 409 instead of an opaque 500.
  const { data: created, error: createErr } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr || !created?.user?.id) {
    const already = /already|exist|registered/i.test(createErr?.message ?? "");
    return Response.json(
      { error: already ? "That email already has an account" : `Could not create user: ${createErr?.message ?? "unknown error"}` },
      { status: already ? 409 : 400 }
    );
  }
  const userId = created.user.id;

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
    // The org_members row failed after the auth user was created — roll the auth
    // user back (best-effort) so a retry isn't blocked by an orphaned account.
    await db.auth.admin.deleteUser(userId).catch(() => undefined);
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

  // Only a super_admin may touch a super_admin (permissions, activation, role):
  // otherwise a members:write admin could strip or deactivate the owner.
  if (target.role === "super_admin" && admin.role !== "super_admin") {
    return Response.json({ error: "Only a super_admin can modify a super_admin" }, { status: 403 });
  }

  if (body?.permissions !== undefined || typeof body?.preset === "string") {
    // Sanitized to the catalogue AND clamped to the granter's own grants, so a
    // non-super-admin can never escalate a member (or themselves) past what they
    // hold. super_admin passes everything through.
    update.permissions = resolvePermissions(body, admin);
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
