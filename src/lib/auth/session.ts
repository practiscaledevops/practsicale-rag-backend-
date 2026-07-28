// Admin session resolution for the dashboard.
//
// RULE (see CLAUDE.md / master plan §0.6): org_id is resolved SERVER-SIDE, never
// from client input. Here we:
//   1. read the authenticated Supabase user from the session cookie, then
//   2. look up their org_members row by user_id using the SERVICE-ROLE client
//      (org_members is behind RLS keyed on a JWT `org_id` claim that the default
//      Supabase session does not carry, so the anon client would see nothing).
//
// The service-role lookup is constrained to the signed-in user's own id, so it
// cannot cross tenants: a user only ever resolves to their own membership.

import { supabaseServer } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase";

export type AdminRole = "super_admin" | "admin";

/** A set of allowed actions per resource, e.g. { prompts: ["read","write"] }. */
export type Permissions = Record<string, string[]>;

export interface AdminSession {
  userId: string;
  orgId: string;
  email: string;
  role: AdminRole;
  permissions: Permissions;
  /** org_members.id — useful as created_by when this admin creates others. */
  memberId: string;
}

/**
 * Resolve the current admin from the Supabase session, or null if not signed in
 * / not a member of any org. Never throws — callers decide how to react (pages
 * redirect, API routes return 401 via requireAdmin()).
 */
export async function getAdmin(): Promise<AdminSession | null> {
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;

  // Look up membership with the service role (bypasses RLS), scoped strictly to
  // this authenticated user id. Prefer an active membership.
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("org_members")
    .select("id, org_id, email, role, permissions, is_active")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  return {
    userId: user.id,
    orgId: data.org_id as string,
    email: (data.email as string) ?? user.email ?? "",
    role: (data.role as AdminRole) ?? "admin",
    permissions: (data.permissions as Permissions) ?? {},
    memberId: data.id as string,
  };
}

/**
 * Does this session hold `action` on `resource`?
 * super_admin bypasses all checks. Permissions shape: { resource: [actions] }.
 */
export function hasPermission(
  session: AdminSession,
  resource: string,
  action: string
): boolean {
  if (session.role === "super_admin") return true;
  const actions = session.permissions?.[resource];
  return Array.isArray(actions) && actions.includes(action);
}
