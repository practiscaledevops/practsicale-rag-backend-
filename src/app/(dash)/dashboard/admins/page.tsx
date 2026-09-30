"use client";

// Admins — manage the org's admins and their granular permissions.
//
// Reads GET /api/admin/members (org resolved server-side, 'members' permission
// enforced). A super_admin can invite/create admins and change roles; anyone
// with 'members' write access can edit permission grants and (de)activate members.
//
// The permission checkboxes, the destructive-action warnings and the one-click
// PRESETS all render from the CATALOGUE the API returns (src/lib/auth/permissions.ts),
// so adding a resource/action there flows through here with no UI change.

import * as React from "react";
import { AlertTriangle, Pencil, UserPlus, Users } from "lucide-react";
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
import { hasAction, can, MIN_PASSWORD_LENGTH, type CatalogueResource, type Preset } from "@/lib/auth/permissions";
import { PermissionGate } from "@/components/auth/PermissionGate";
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
  permissions?: Permissions;
}

const ROLE_LABEL: Record<Role, string> = { admin: "Admin", super_admin: "Super admin" };
const ROLE_OPTIONS = [
  { value: "admin", label: ROLE_LABEL.admin },
  { value: "super_admin", label: ROLE_LABEL.super_admin },
];

/** Fallbacks when the catalogue hasn't loaded (or a stored resource is unknown). */
const FALLBACK_RESOURCE_LABELS: Record<string, string> = { api_keys: "API keys", data_sources: "Data sources" };

/** Deep-clone a permissions map (so editing a preset never mutates the source). */
function clonePermissions(perms: Permissions): Permissions {
  return Object.fromEntries(Object.entries(perms).map(([k, v]) => [k, [...v]]));
}

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
  const [catalogue, setCatalogue] = React.useState<CatalogueResource[]>([]);
  const [presets, setPresets] = React.useState<Preset[]>([]);
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
      setCatalogue(json.catalogue ?? []);
      setPresets(json.presets ?? []);
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
  // Who may edit members: a super admin, or a member holding members:write. A
  // view-only member (members:read) sees the list but not the edit affordance —
  // opening the editor would only 403 on Save (the API is the real gate).
  const canManage = isSuper || hasAction(viewer?.permissions, "members", "write");

  const resourceLabel = React.useCallback(
    (id: string) => catalogue.find((r) => r.id === id)?.label ?? FALLBACK_RESOURCE_LABELS[id] ?? humanize(id),
    [catalogue]
  );
  const actionLabel = React.useCallback(
    (resource: string, id: string) =>
      catalogue.find((r) => r.id === resource)?.actions.find((a) => a.id === id)?.label ?? humanize(id),
    [catalogue]
  );

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
    <PermissionGate resource="members">
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
                            <Tag key={resource}>
                              {resourceLabel(resource)}: {actions.map((a) => actionLabel(resource, a)).join(", ")}
                            </Tag>
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
                      {canManage && (
                        <Button variant="secondary" size="sm" onClick={() => setEditing(m)}>
                          <Pencil size={14} aria-hidden />
                          Edit
                          <span className="sr-only"> {m.email}</span>
                        </Button>
                      )}
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
          catalogue={catalogue}
          presets={presets}
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
          catalogue={catalogue}
          presets={presets}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
    </PermissionGate>
  );
}

/** One-click preset buttons that fill the checkboxes below (still editable after). */
function PresetPicker({
  presets,
  onApply,
  onClear,
  disabled,
  viewer,
}: {
  presets: Preset[];
  onApply: (perms: Permissions) => void;
  onClear: () => void;
  disabled?: boolean;
  viewer?: Viewer;
}) {
  if (presets.length === 0) return null;
  // A non-super granter can't apply a preset that includes an access they lack
  // (the server clamps it away); disable it so the UI doesn't promise a grant
  // that won't stick.
  const restrict = !!viewer && viewer.role !== "super_admin";
  const presetExceeds = (p: Preset) =>
    restrict &&
    Object.entries(p.permissions).some(([resource, actions]) =>
      actions.some((a) => !can({ role: viewer!.role, permissions: viewer!.permissions ?? {} }, `${resource}:${a}`))
    );
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">Start from a preset</p>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <Button
            key={p.id}
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled || presetExceeds(p)}
            title={presetExceeds(p) ? "Includes an access you don't have" : p.description}
            onClick={() => onApply(clonePermissions(p.permissions))}
          >
            {p.label}
          </Button>
        ))}
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onClear}>
          Clear all
        </Button>
      </div>
    </div>
  );
}

/** Checkbox groups for granting resource:action permissions: one fieldset per resource. */
function PermissionEditor({
  catalogue,
  value,
  onChange,
  disabled,
  viewer,
}: {
  catalogue: CatalogueResource[];
  value: Permissions;
  onChange: (next: Permissions) => void;
  disabled?: boolean;
  viewer?: Viewer;
}) {
  // A non-super granter can only grant actions they themselves hold (mirrors the
  // server's clampToGranter), so the UI never offers a grant the server drops.
  const restrict = !!viewer && viewer.role !== "super_admin";
  const canGrant = (key: string) =>
    !restrict || can({ role: viewer!.role, permissions: viewer!.permissions ?? {} }, key);
  return (
    <div className="grid gap-x-4 gap-y-3 rounded-xl border border-border p-3 sm:grid-cols-2">
      {catalogue.map((resource) => {
        // Read is implied by any write-like action; show it checked + locked then.
        const impliedRead = hasAction(value, resource.id, "read") && !(value[resource.id]?.includes("read") ?? false);
        const destructive = resource.actions.filter((a) => a.destructive);
        return (
          <fieldset key={resource.id} disabled={disabled} className="min-w-0">
            <legend className="px-2 text-xs font-medium text-muted-foreground" title={resource.description}>
              {resource.label}
            </legend>
            <div className="flex flex-wrap gap-x-1">
              {resource.actions.map((action) => {
                const isRead = action.id === "read";
                const checked = isRead ? impliedRead || (value[resource.id]?.includes("read") ?? false) : value[resource.id]?.includes(action.id) ?? false;
                const lockRead = isRead && impliedRead;
                const ungrantable = !canGrant(`${resource.id}:${action.id}`);
                return (
                  <label
                    key={action.id}
                    title={ungrantable ? "You can't grant an access you don't have yourself" : action.description}
                    className={cn(
                      "flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] transition-colors",
                      action.destructive ? "text-danger" : "text-foreground",
                      disabled || lockRead || ungrantable ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-surface-muted"
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={disabled || lockRead || ungrantable}
                      onChange={(e) => onChange(togglePermission(value, resource.id, action.id, e.target.checked))}
                    />
                    {action.label}
                  </label>
                );
              })}
            </div>
            {destructive.length > 0 && (
              <p className="mt-0.5 flex items-center gap-1 px-2 text-xs text-danger">
                <AlertTriangle size={12} aria-hidden className="shrink-0" />
                {destructive.map((a) => a.label).join(" / ")} permanently removes data.
              </p>
            )}
          </fieldset>
        );
      })}
    </div>
  );
}

/** The whole permission picker: presets on top, granular checkboxes below. */
function PermissionsField({
  catalogue,
  presets,
  value,
  onChange,
  viewer,
}: {
  catalogue: CatalogueResource[];
  presets: Preset[];
  value: Permissions;
  onChange: (next: Permissions) => void;
  viewer?: Viewer;
}) {
  return (
    <fieldset className="min-w-0 space-y-2.5">
      <legend className="text-xs font-medium text-muted-foreground">Permissions</legend>
      <PresetPicker presets={presets} onApply={onChange} onClear={() => onChange({})} viewer={viewer} />
      <PermissionEditor catalogue={catalogue} value={value} onChange={onChange} viewer={viewer} />
      <p className="text-xs text-muted-foreground">
        Holding write or delete on a section includes read of it.
      </p>
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
  catalogue,
  presets,
  onClose,
  onSaved,
}: {
  catalogue: CatalogueResource[];
  presets: Preset[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [role, setRole] = React.useState<Role>("admin");
  const [permissions, setPermissions] = React.useState<Permissions>({});
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const pwTooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;

  async function submit() {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password, role, permissions }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Could not add the member");
    } finally {
      setSaving(false);
    }
  }

  const canSubmit = !!email.trim() && password.length >= MIN_PASSWORD_LENGTH;

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a member"
      description="Set their email and a password; they can sign in straight away and change the password from their profile."
      size="lg"
      closeOnBackdrop={false}
      dismissible={!saving}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit} loading={saving}>
            {saving ? "Adding…" : "Add member"}
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
          label="Password"
          hint={`At least ${MIN_PASSWORD_LENGTH} characters. Share it with them securely; they can change it from their profile.`}
          error={pwTooShort ? `Use at least ${MIN_PASSWORD_LENGTH} characters` : undefined}
        >
          <Input
            id="invite-password"
            type="password"
            autoComplete="new-password"
            placeholder="Set a password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
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

        {role === "admin" && (
          <PermissionsField catalogue={catalogue} presets={presets} value={permissions} onChange={setPermissions} />
        )}
      </div>
    </Dialog>
  );
}

function EditDialog({
  member,
  viewer,
  catalogue,
  presets,
  onClose,
  onSaved,
}: {
  member: Member;
  viewer: Viewer;
  catalogue: CatalogueResource[];
  presets: Preset[];
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
            <PermissionsField catalogue={catalogue} presets={presets} value={permissions} onChange={setPermissions} viewer={viewer} />
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
