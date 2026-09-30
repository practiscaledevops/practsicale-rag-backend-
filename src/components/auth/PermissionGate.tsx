"use client";

// Per-page access gating for the dashboard.
//
// AppShell wraps every dashboard page in <PermissionProvider> with the signed-in
// member's role + permissions (resolved server-side, threaded through the shell).
// A governed page wraps its content in <PermissionGate resource="documents">, and
// a member who lacks read of that resource sees a friendly "no access" notice
// instead of the page — while the nav already hides what they can't reach and the
// API routes enforce the same grants server-side.
//
// super_admin bypasses all (via can()). Read is implied by write/delete, so a
// member with only documents:[write] still passes resource="documents".

import * as React from "react";
import { ShieldAlert } from "lucide-react";
import type { AdminRole, Permissions } from "@/lib/auth/session";
import { can, type PermissionSubject } from "@/lib/auth/permissions";
import { EmptyState } from "@/components/ui/EmptyState";

const PermissionContext = React.createContext<PermissionSubject | null>(null);

export function PermissionProvider({
  role,
  permissions,
  children,
}: {
  role?: AdminRole;
  permissions?: Permissions;
  children: React.ReactNode;
}) {
  const value = React.useMemo<PermissionSubject>(
    () => ({ role: role ?? "admin", permissions: permissions ?? {} }),
    [role, permissions]
  );
  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>;
}

/** The current member's role+permissions, or null when no provider is mounted. */
export function usePermissionSubject(): PermissionSubject | null {
  return React.useContext(PermissionContext);
}

/**
 * Does the current member satisfy a "<resource>:<action>" key? Returns true when
 * no provider is mounted (fail open on the client — the server API is the real
 * gate), so a page never renders blank because the context wasn't wired.
 */
export function useCan(permissionKey: string): boolean {
  const subject = usePermissionSubject();
  return subject ? can(subject, permissionKey) : true;
}

/** The "you don't have access" placeholder shown in place of a gated section. */
export function NoAccessNotice({
  title = "You don't have access to this section",
  description = "Ask a super admin to grant you access if you need it.",
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
}) {
  return (
    <div className="py-10">
      <EmptyState icon={ShieldAlert} title={title} description={description} />
    </div>
  );
}

/**
 * Render `children` only when the member holds `action` (default "read") on
 * `resource`; otherwise render the no-access notice.
 */
export function PermissionGate({
  resource,
  action = "read",
  children,
  title,
  description,
}: {
  resource: string;
  action?: string;
  children: React.ReactNode;
  title?: React.ReactNode;
  description?: React.ReactNode;
}) {
  const allowed = useCan(`${resource}:${action}`);
  if (allowed) return <>{children}</>;
  return <NoAccessNotice title={title} description={description} />;
}
