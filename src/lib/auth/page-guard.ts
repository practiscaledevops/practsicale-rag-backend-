// Server-side page guard for dashboard SERVER components.
//
// Most dashboard pages are client components and gate themselves with
// <PermissionGate resource="…"> (which reads the permission context AppShell
// provides). A server component page instead calls pageAccess() to learn whether
// the signed-in member may see the section, then renders either its content or
// <NoAccessNotice/>. super_admin (and demo) always pass.
//
// Example (server component):
//   const { session, allowed } = await pageAccess("documents:read");
//   if (!session) redirect("/login");
//   if (!allowed) return <NoAccessNotice />;

import { getAdmin, type AdminSession } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";

export interface PageAccess {
  /** The signed-in member, or null when unauthenticated (page should redirect). */
  session: AdminSession | null;
  /** True when the member may see the section (super_admin/demo always true). */
  allowed: boolean;
}

/** Resolve the session and whether it satisfies `permissionKey` ("<resource>:<action>"). */
export async function pageAccess(permissionKey: string): Promise<PageAccess> {
  const session = await getAdmin();
  if (!session) return { session: null, allowed: false };
  return { session, allowed: can(session, permissionKey) };
}
