"use client";

// Admins — manage the org's admins and their granular permissions.
//
// Reads GET /api/admin/members (org resolved server-side, 'members' permission
// enforced). A super_admin can invite/create admins and change roles; anyone
// with 'members' access can edit permission grants and (de)activate members.

import * as React from "react";
import { Pencil, UserPlus, Users } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select, type SelectProps } from "@/components/ui/Select";
import { Field } from "@/components/ui/Field";
import { SwitchRow } from "@/components/ui/Switch";
import { Checkbox } from "@/components/ui/Checkbox";
import { Badge, Tag } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import { Dialog } from "@/components/ui/Dialog";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Table, THead, TBody, Tr, Th, Td, TableCard, TableSkeletonRows } from "@/components/ui/Table";
import { fmtInt, humanize } from "@/lib/format";
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
const ROLE_OPTIONS = [
  { value: "admin", label: ROLE_LABEL.admin },
  { value: "super_admin", label: ROLE_LABEL.super_admin },
];

/** Resource names that humanize() would get wrong. */
const RESOURCE_LABELS: Record<string, string> = { api_keys: "API keys" };
const resourceLabel = (r: string) => RESOURCE_LABELS[r] ?? humanize(r);

/** "Documents: Read, Write". */
const permissionSummary = (resource: string, actions: string[]) =>
  `${resourceLabel(resource)}: ${actions.map(humanize).join(", ")}`;

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

  const head = (
    <THead>
      <tr>
        <Th>Email</Th>
        <Th>Role</Th>
        <Th>Permissions</Th>
        <Th>Status</Th>
        <Th className="text-right">
          <span className="sr-only">Actions</span>
        </Th>
      </tr>
    </THead>
  );

  return (
    <div>
      <PageHeader
        title="Admins"
        description="Who can sign in to the Brain and what each person can change."
        actions={
          isSuper ? (
            <Button size="toolbar" onClick={() => setInviteOpen(true)}>
              <UserPlus size={14} aria-hidden />
              Invite admin
            </Button>
          ) : undefined
        }
      />

      {error && (
        <Alert tone="danger" className="mb-4">
          <span className="font-medium">Couldn&apos;t load admins.</span> {error}
        </Alert>
      )}

      {loading ? (
        <TableCard>
          <Table minWidth={720} caption="Admins" aria-busy="true">
            {head}
            <TBody>
              <TableSkeletonRows rows={4} cols={5} />
            </TBody>
          </Table>
        </TableCard>
      ) : members.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No admins yet"
          description={isSuper ? "Invite your first admin to get started." : "No members to show."}
          action={
            isSuper ? (
              <Button size="toolbar" onClick={() => setInviteOpen(true)}>
                <UserPlus size={14} aria-hidden />
                Invite admin
              </Button>
            ) : undefined
          }
        />
      ) : (
        <TableCard
          title="Members"
          meta={`${fmtInt(members.length)} ${members.length === 1 ? "person" : "people"}`}
        >
          <Table minWidth={720} caption="Admins">
            {head}
            <TBody>
              {members.map((m) => {
                const grants = Object.entries(m.permissions ?? {}).filter(([, actions]) => actions.length > 0);
                return (
                  <Tr key={m.id}>
                    <Td className="font-medium">
                      <span className="break-all">{m.email}</span>
                      {viewer?.memberId === m.id && <Tag className="ml-2 align-middle">You</Tag>}
                    </Td>
                    <Td>
                      <Badge tone={m.role === "super_admin" ? "accent" : "neutral"}>{ROLE_LABEL[m.role]}</Badge>
                    </Td>
                    <Td>
                      {m.role === "super_admin" ? (
                        <span className="text-muted-foreground">All access</span>
                      ) : grants.length === 0 ? (
                        <span className="text-muted-foreground">None</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {grants.map(([resource, actions]) => (
                            <Tag key={resource}>{permissionSummary(resource, actions)}</Tag>
                          ))}
                        </div>
                      )}
                    </Td>
                    <Td>
                      {m.is_active ? (
                        <Badge tone="success">Active</Badge>
                      ) : (
                        <Badge tone="neutral">Inactive</Badge>
                      )}
                    </Td>
                    <Td className="text-right">
                      <Button variant="secondary" size="sm" onClick={() => setEditing(m)}>
                        <Pencil size={14} aria-hidden />
                        Edit
                        <span className="sr-only"> {m.email}</span>
                      </Button>
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        </TableCard>
      )}

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

/** Checkbox groups for granting resource:action permissions: one fieldset per resource. */
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
    <div className="grid gap-x-4 gap-y-2.5 rounded-xl border border-border p-3 sm:grid-cols-2">
      {resources.map((resource) => (
        <fieldset key={resource} disabled={disabled} className="min-w-0">
          <legend className="px-2 text-xs font-medium text-muted-foreground">{resourceLabel(resource)}</legend>
          <div className="flex flex-wrap gap-x-1">
            {allowed[resource].map((action) => {
              const checked = value[resource]?.includes(action) ?? false;
              return (
                <label
                  key={action}
                  className={cn(
                    "flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-[13px] text-foreground transition-colors hover:bg-surface-muted",
                    disabled && "cursor-not-allowed opacity-60"
                  )}
                >
                  <Checkbox
                    checked={checked}
                    disabled={disabled}
                    onChange={(e) => onChange(togglePermission(value, resource, action, e.target.checked))}
                  />
                  {humanize(action)}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

/** The whole permission picker, as a labelled group. */
function PermissionsField({
  allowed,
  value,
  onChange,
}: {
  allowed: Permissions;
  value: Permissions;
  onChange: (next: Permissions) => void;
}) {
  return (
    <fieldset className="min-w-0 space-y-1.5">
      <legend className="text-xs font-medium text-muted-foreground">Permissions</legend>
      <PermissionEditor allowed={allowed} value={value} onChange={onChange} />
    </fieldset>
  );
}

type RoleSelectProps = Omit<SelectProps, "value" | "onChange" | "options"> & {
  value: Role;
  onChange: (r: Role) => void;
};

/** Labelled by its Field (which passes id and aria-describedby through). */
function RoleSelect({ value, onChange, ...props }: RoleSelectProps) {
  return (
    <Select
      {...props}
      value={value}
      onChange={(e) => onChange(e.target.value as Role)}
      options={ROLE_OPTIONS}
      className="sm:w-56"
    />
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
      size="lg"
      closeOnBackdrop={false}
      dismissible={!saving}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!email.trim()} loading={saving}>
            {saving ? "Inviting…" : "Send invite"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {err && <Alert tone="danger">{err}</Alert>}

        <Field label="Email">
          <Input
            id="invite-email"
            type="email"
            placeholder="teammate@practiscale.co"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
        </Field>

        <Field
          label="Role"
          hint={
            role === "super_admin"
              ? "Super admins have full access, so individual permissions don't apply."
              : undefined
          }
        >
          <RoleSelect id="invite-role" value={role} onChange={setRole} />
        </Field>

        {role === "admin" && <PermissionsField allowed={allowed} value={permissions} onChange={setPermissions} />}
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
  const { confirm, dialog } = useConfirm();

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

  /** Deactivating someone asks first; everything else saves straight away. */
  async function requestSubmit() {
    if (!isSelf && member.is_active && !isActive) {
      const ok = await confirm({
        title: `Deactivate ${member.email}?`,
        description: "They won't be able to sign in to the Brain until an admin reactivates them.",
        tone: "danger",
        confirmLabel: "Deactivate",
      });
      if (!ok) return;
    }
    await submit();
  }

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title={`Edit ${member.email}`}
        description="Adjust role, permissions, and access."
        size="lg"
        closeOnBackdrop={false}
        dismissible={!saving}
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void requestSubmit()} loading={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {err && <Alert tone="danger">{err}</Alert>}

          <Field
            label="Role"
            hint={
              canChangeRole
                ? undefined
                : isSelf
                  ? "You can't change your own role."
                  : "Only a super admin can change roles."
            }
          >
            <RoleSelect id="edit-role" value={role} onChange={setRole} disabled={!canChangeRole} />
          </Field>

          {role === "admin" ? (
            <PermissionsField allowed={allowed} value={permissions} onChange={setPermissions} />
          ) : (
            <p className="text-[13px] text-muted-foreground">
              Super admins have full access; individual permissions don&apos;t apply.
            </p>
          )}

          {!isSelf && (
            <SwitchRow
              title="Account active"
              hint="Inactive admins can't sign in to the Brain."
              checked={isActive}
              onChange={setIsActive}
            />
          )}
        </div>
      </Dialog>
      {dialog}
    </>
  );
}
