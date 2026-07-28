"use client";

// Admins — manage the org's admins and their granular permissions.
//
// Reads GET /api/admin/members (org resolved server-side, 'members' permission
// enforced). A super_admin can invite/create admins and change roles; anyone
// with 'members' access can edit permission grants and (de)activate members.

import * as React from "react";
import { UserPlus, Users, Pencil } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Badge } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Table, THead, TBody, Tr, Th, Td } from "@/components/ui/Table";
import { cn } from "@/lib/utils";

type Role = "admin" | "super_admin";
type Permissions = Record<string, string[]>;

interface Member {
  id: string;
  email: string;
  role: Role;
  permissions: Permissions;
  is_active: boolean;
  user_id: string | null;
  created_at: string;
}
interface Viewer {
  memberId: string;
  role: Role;
}

const ROLE_LABEL: Record<Role, string> = { admin: "Admin", super_admin: "Super admin" };

/** Add/remove an action for a resource, pruning empty resources. */
function togglePermission(
  perms: Permissions,
  resource: string,
  action: string,
  checked: boolean
): Permissions {
  const set = new Set(perms[resource] ?? []);
  if (checked) set.add(action);
  else set.delete(action);
  const next = { ...perms };
  if (set.size > 0) next[resource] = [...set];
  else delete next[resource];
  return next;
}

export default function AdminsPage() {
  const [members, setMembers] = React.useState<Member[]>([]);
  const [viewer, setViewer] = React.useState<Viewer | null>(null);
  const [allowed, setAllowed] = React.useState<Permissions>({});
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Member | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/members", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
      setMembers(json.members ?? []);
      setViewer(json.viewer ?? null);
      setAllowed(json.allowedPermissions ?? {});
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load members");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const isSuper = viewer?.role === "super_admin";

  return (
    <div>
      <PageHeader
        title="Admins"
        description="People with access to this Brain and what each of them can do."
        actions={
          isSuper ? (
            <Button onClick={() => setInviteOpen(true)}>
              <UserPlus className="h-4 w-4" aria-hidden="true" />
              Invite admin
            </Button>
          ) : undefined
        }
      />

      {error && (
        <Alert tone="danger" title="Something went wrong" className="mb-6">
          {error}
        </Alert>
      )}

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading…</p>
          ) : members.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={Users}
                title="No admins yet"
                description={isSuper ? "Invite your first admin to get started." : "No members to show."}
                action={
                  isSuper ? (
                    <Button onClick={() => setInviteOpen(true)}>
                      <UserPlus className="h-4 w-4" aria-hidden="true" />
                      Invite admin
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th>Email</Th>
                  <Th>Role</Th>
                  <Th>Permissions</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </THead>
              <TBody>
                {members.map((m) => (
                  <Tr key={m.id}>
                    <Td className="font-medium">
                      {m.email}
                      {viewer?.memberId === m.id && (
                        <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                      )}
                    </Td>
                    <Td>
                      <Badge tone={m.role === "super_admin" ? "accent" : "neutral"}>
                        {ROLE_LABEL[m.role]}
                      </Badge>
                    </Td>
                    <Td>
                      {m.role === "super_admin" ? (
                        <span className="text-sm text-muted-foreground">All access</span>
                      ) : Object.keys(m.permissions ?? {}).length === 0 ? (
                        <span className="text-sm text-muted-foreground">None</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {Object.keys(m.permissions).map((r) => (
                            <Badge key={r} tone="neutral">
                              {r.replace(/_/g, " ")}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </Td>
                    <Td>
                      {m.is_active ? (
                        <Badge tone="success">Active</Badge>
                      ) : (
                        <Badge tone="warning">Inactive</Badge>
                      )}
                    </Td>
                    <Td className="text-right">
                      <Button variant="outline" size="sm" onClick={() => setEditing(m)}>
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                        Edit
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {inviteOpen && (
        <InviteDialog
          allowed={allowed}
          onClose={() => setInviteOpen(false)}
          onSaved={() => {
            setInviteOpen(false);
            void load();
          }}
        />
      )}

      {editing && viewer && (
        <EditDialog
          member={editing}
          viewer={viewer}
          allowed={allowed}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

/** Checkbox grid for granting resource:action permissions. */
function PermissionEditor({
  allowed,
  value,
  onChange,
  disabled,
}: {
  allowed: Permissions;
  value: Permissions;
  onChange: (next: Permissions) => void;
  disabled?: boolean;
}) {
  const resources = Object.keys(allowed);
  return (
    <div className="space-y-3">
      {resources.map((resource) => (
        <div key={resource} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-sm font-medium capitalize">{resource.replace(/_/g, " ")}</span>
          <div className="flex flex-wrap gap-3">
            {allowed[resource].map((action) => {
              const checked = value[resource]?.includes(action) ?? false;
              return (
                <label
                  key={action}
                  className={cn(
                    "inline-flex items-center gap-1.5 text-sm text-muted-foreground",
                    disabled && "opacity-60"
                  )}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-border accent-accent"
                    checked={checked}
                    disabled={disabled}
                    onChange={(e) => onChange(togglePermission(value, resource, action, e.target.checked))}
                  />
                  {action}
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function RoleSelect({
  value,
  onChange,
  disabled,
  id,
}: {
  value: Role;
  onChange: (r: Role) => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as Role)}
      className={cn(
        "h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50"
      )}
    >
      <option value="admin">Admin</option>
      <option value="super_admin">Super admin</option>
    </select>
  );
}

function InviteDialog({
  allowed,
  onClose,
  onSaved,
}: {
  allowed: Permissions;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<Role>("admin");
  const [permissions, setPermissions] = React.useState<Permissions>({ analytics: ["read"] });
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  async function submit() {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), role, permissions }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Could not create admin");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Invite an admin"
      description="They receive an email invite to set a password, then can sign in with the access you grant."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={saving || !email.trim()}>
            {saving ? "Inviting…" : "Send invite"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 py-2">
        {err && <Alert tone="danger">{err}</Alert>}

        <div className="space-y-1.5">
          <Label htmlFor="invite-email">Email</Label>
          <Input
            id="invite-email"
            type="email"
            placeholder="teammate@practiscale.co"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="invite-role">Role</Label>
          <RoleSelect id="invite-role" value={role} onChange={setRole} />
          {role === "super_admin" && (
            <p className="text-xs text-muted-foreground">
              Super admins have full access; individual permissions below are ignored.
            </p>
          )}
        </div>

        {role === "admin" && (
          <div className="space-y-2">
            <Label>Permissions</Label>
            <PermissionEditor allowed={allowed} value={permissions} onChange={setPermissions} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

function EditDialog({
  member,
  viewer,
  allowed,
  onClose,
  onSaved,
}: {
  member: Member;
  viewer: Viewer;
  allowed: Permissions;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [role, setRole] = React.useState<Role>(member.role);
  const [permissions, setPermissions] = React.useState<Permissions>(member.permissions ?? {});
  const [isActive, setIsActive] = React.useState(member.is_active);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const isSelf = viewer.memberId === member.id;
  const canChangeRole = viewer.role === "super_admin" && !isSelf;

  async function submit() {
    setSaving(true);
    setErr(null);
    try {
      const payload: Record<string, unknown> = { memberId: member.id, permissions };
      if (canChangeRole && role !== member.role) payload.role = role;
      if (!isSelf && isActive !== member.is_active) payload.is_active = isActive;

      const res = await fetch("/api/admin/members", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Could not update member");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Edit ${member.email}`}
      description="Adjust role, permissions, and access."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 py-2">
        {err && <Alert tone="danger">{err}</Alert>}

        <div className="space-y-1.5">
          <Label htmlFor="edit-role">Role</Label>
          <RoleSelect id="edit-role" value={role} onChange={setRole} disabled={!canChangeRole} />
          {!canChangeRole && (
            <p className="text-xs text-muted-foreground">
              {isSelf ? "You cannot change your own role." : "Only a super admin can change roles."}
            </p>
          )}
        </div>

        {role === "admin" ? (
          <div className="space-y-2">
            <Label>Permissions</Label>
            <PermissionEditor allowed={allowed} value={permissions} onChange={setPermissions} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Super admins have full access; individual permissions do not apply.
          </p>
        )}

        {!isSelf && (
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border accent-accent"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            Active (can sign in)
          </label>
        )}
      </div>
    </Dialog>
  );
}
