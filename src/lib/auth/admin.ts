// Admin guard for dashboard pages and admin API routes.
//
// Usage:
//   const admin = await requireAdmin();                 // any signed-in admin
//   const admin = await requireAdmin("prompts:write");  // + a specific grant
//
// The permission key is "<resource>:<action>" (e.g. "api_keys:revoke"). A bare
// resource ("prompts") requires the presence of any action on it. super_admin
// bypasses every check.
//
// Behaviour differs by caller:
//   - API routes: catch AdminAuthError and return err.status (401/403). Use the
//     re-export in src/app/api/admin/_guard.ts.
//   - Pages: catch and redirect to /login (401) or render a 403 notice.

import { getAdmin, hasPermission, type AdminSession } from "./session";

export class AdminAuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AdminAuthError";
    this.status = status;
  }
}

/**
 * Ensure a signed-in admin, optionally holding a permission.
 * Throws AdminAuthError(401) when unauthenticated, AdminAuthError(403) when the
 * permission is missing. Returns the resolved session otherwise.
 */
export async function requireAdmin(permissionKey?: string): Promise<AdminSession> {
  const session = await getAdmin();
  if (!session) throw new AdminAuthError("Not authenticated", 401);

  if (permissionKey) {
    const [resource, action] = permissionKey.split(":");
    const ok =
      session.role === "super_admin" ||
      (action
        ? hasPermission(session, resource, action)
        : Array.isArray(session.permissions?.[resource]) &&
          session.permissions[resource].length > 0);
    if (!ok) {
      throw new AdminAuthError(`Missing permission '${permissionKey}'`, 403);
    }
  }

  return session;
}
