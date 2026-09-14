"use client";

import * as React from "react";
import { FolderOpen, Layers, Loader2, Pencil, Plus, Trash2, ShieldCheck, Lock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/Card";
import { Table, THead, TBody, Tr, Th, Td } from "@/components/ui/Table";
import { ACCESS_LEVELS } from "@/lib/knowledge-taxonomy";
import { WORK_MODES, MODE_LABELS } from "@/lib/prompts";

/** Governance config for a collection (stored in collections.settings jsonb). */
export interface CollectionSettings {
  owner?: string;
  access_level?: string;
  allowed_work_modes?: string[];
  review_interval_days?: number | null;
  retention_days?: number | null;
  default_source_type?: string;
  ceo_copilot_eligible?: boolean;
  employee_chat_eligible?: boolean;
  client_facing_eligible?: boolean;
}

/** One collection row (document_count is aggregated server-side). */
export interface CollectionRow {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  created_at: string;
  document_count: number;
  settings?: CollectionSettings;
}

/** A document offered in the assign-documents picker. */
export interface DocumentOption {
  id: string;
  title: string | null;
  source_type: string;
}

const SOURCE_LABELS: Record<string, string> = {
  document: "Document",
  call_score: "Call score",
  coaching: "Coaching",
  transcript: "Transcript",
};
const sourceLabel = (v: string) => SOURCE_LABELS[v] ?? v;

const accessLabel = (v?: string) => ACCESS_LEVELS.find((a) => a.value === v)?.label ?? "Team";

export function CollectionsClient({
  collections: initialCollections,
  documents,
  membership: initialMembership,
  governanceEnabled = true,
}: {
  collections: CollectionRow[];
  documents: DocumentOption[];
  membership: Record<string, string[]>;
  governanceEnabled?: boolean;
}) {
  // Local, authoritative state — mutations update it directly from API responses,
  // so counts and membership stay live without a full server round-trip.
  const [collections, setCollections] = React.useState(initialCollections);
  const [membership, setMembership] = React.useState<Record<string, string[]>>(
    () => initialMembership
  );

  // Create-form state.
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [formOk, setFormOk] = React.useState<string | null>(null);

  // Dialog targets.
  const [renameTarget, setRenameTarget] = React.useState<CollectionRow | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<CollectionRow | null>(null);
  const [manageTarget, setManageTarget] = React.useState<CollectionRow | null>(null);
  const [settingsTarget, setSettingsTarget] = React.useState<CollectionRow | null>(null);

  const docCount = (id: string) => membership[id]?.length ?? 0;

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormOk(null);
    setCreating(true);
    try {
      const res = await fetch("/api/admin/collections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(json.error ?? `Request failed (${res.status})`);
        return;
      }
      const created = json.collection as CollectionRow;
      setCollections((prev) => [created, ...prev]);
      setMembership((prev) => ({ ...prev, [created.id]: [] }));
      setFormOk(`Created collection “${created.name}”.`);
      setName("");
      setDescription("");
    } catch {
      setFormError("Network error — please try again.");
    } finally {
      setCreating(false);
    }
  }

  if (collections.length === 0) {
    return (
      <div className="space-y-6">
        <CreateForm
          name={name}
          description={description}
          creating={creating}
          formError={formError}
          formOk={formOk}
          setName={setName}
          setDescription={setDescription}
          onSubmit={onCreate}
        />
        <EmptyState
          icon={Layers}
          title="No collections yet"
          description="Create a collection above, then assign documents to it. Scoped API keys can be limited to specific collections."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <CreateForm
        name={name}
        description={description}
        creating={creating}
        formError={formError}
        formOk={formOk}
        setName={setName}
        setDescription={setDescription}
        onSubmit={onCreate}
      />

      {!governanceEnabled && (
        <Alert tone="warning">
          Governance settings (owner, access level, work modes, review &amp; retention) are
          disabled — run migration <code>0013_collection_settings.sql</code> to enable them.
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Collections</CardTitle>
          <CardDescription>
            A collection is the governance unit for knowledge: owner, access level, which work
            modes may use it, and review &amp; retention. Scoped API keys can be limited to one.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <THead>
              <Tr>
                <Th>Name</Th>
                <Th>Access</Th>
                <Th>Owner</Th>
                <Th className="text-right">Documents</Th>
                <Th>Eligibility</Th>
                <Th className="text-right">Actions</Th>
              </Tr>
            </THead>
            <TBody>
              {collections.map((c) => {
                const s = c.settings ?? {};
                const restricted = ["restricted", "confidential", "ceo_only"].includes(s.access_level ?? "");
                return (
                <Tr key={c.id}>
                  <Td className="font-medium">
                    {c.name}
                    {c.description && (
                      <span className="block max-w-[32ch] truncate text-xs text-muted-foreground" title={c.description}>
                        {c.description}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                      {restricted && <Lock className="h-3 w-3" aria-hidden="true" />}
                      {accessLabel(s.access_level)}
                    </span>
                  </Td>
                  <Td className="text-muted-foreground">{s.owner || "—"}</Td>
                  <Td className="text-right tabular-nums">
                    <Badge tone="accent">{docCount(c.id)}</Badge>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {s.ceo_copilot_eligible !== false && <Badge tone="neutral">Copilot</Badge>}
                      {s.employee_chat_eligible !== false && <Badge tone="neutral">Team chat</Badge>}
                      {s.client_facing_eligible && <Badge tone="warning">Client-facing</Badge>}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSettingsTarget(c)}
                        aria-label={`Governance settings for ${c.name}`}
                        disabled={!governanceEnabled}
                        title={governanceEnabled ? "Governance settings" : "Run migration 0013 to enable governance"}
                      >
                        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setManageTarget(c)}
                        aria-label={`Manage documents in ${c.name}`}
                      >
                        <FolderOpen className="h-4 w-4" aria-hidden="true" />
                        Documents
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setRenameTarget(c)}
                        aria-label={`Rename ${c.name}`}
                      >
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteTarget(c)}
                        aria-label={`Delete ${c.name}`}
                      >
                        <Trash2 className="h-4 w-4 text-danger" aria-hidden="true" />
                      </Button>
                    </div>
                  </Td>
                </Tr>
                );
              })}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      {renameTarget && (
        <RenameDialog
          target={renameTarget}
          onClose={() => setRenameTarget(null)}
          onRenamed={(updated) =>
            setCollections((prev) => prev.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)))
          }
        />
      )}

      {deleteTarget && (
        <DeleteDialog
          target={deleteTarget}
          count={docCount(deleteTarget.id)}
          onClose={() => setDeleteTarget(null)}
          onDeleted={(id) => {
            setCollections((prev) => prev.filter((c) => c.id !== id));
            setMembership((prev) => {
              const next = { ...prev };
              delete next[id];
              return next;
            });
          }}
        />
      )}

      {manageTarget && (
        <ManageDocumentsDialog
          target={manageTarget}
          documents={documents}
          memberIds={membership[manageTarget.id] ?? []}
          onClose={() => setManageTarget(null)}
          onChange={(documentId, isMember) =>
            setMembership((prev) => {
              const current = new Set(prev[manageTarget.id] ?? []);
              if (isMember) current.add(documentId);
              else current.delete(documentId);
              return { ...prev, [manageTarget.id]: [...current] };
            })
          }
        />
      )}

      {settingsTarget && (
        <GovernanceDialog
          target={settingsTarget}
          onClose={() => setSettingsTarget(null)}
          onSaved={(id, settings) =>
            setCollections((prev) => prev.map((c) => (c.id === id ? { ...c, settings } : c)))
          }
        />
      )}
    </div>
  );
}

// --- Create form -------------------------------------------------------------

function CreateForm(props: {
  name: string;
  description: string;
  creating: boolean;
  formError: string | null;
  formOk: string | null;
  setName: (v: string) => void;
  setDescription: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>New collection</CardTitle>
        <CardDescription>
          Name a group of documents. A scoped API key can be limited to it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={props.onSubmit} className="space-y-4">
          {props.formError && <Alert tone="danger">{props.formError}</Alert>}
          {props.formOk && <Alert tone="success">{props.formOk}</Alert>}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="col-name">Name</Label>
              <Input
                id="col-name"
                required
                value={props.name}
                onChange={(e) => props.setName(e.target.value)}
                placeholder="Sales playbooks"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="col-desc">Description</Label>
              <Input
                id="col-desc"
                value={props.description}
                onChange={(e) => props.setDescription(e.target.value)}
                placeholder="Optional — what this collection holds"
              />
            </div>
          </div>

          <div className="flex justify-end">
            <Button type="submit" disabled={props.creating}>
              {props.creating ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Plus className="h-4 w-4" aria-hidden="true" />
              )}
              {props.creating ? "Creating…" : "Create collection"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// --- Rename dialog -----------------------------------------------------------

function RenameDialog({
  target,
  onClose,
  onRenamed,
}: {
  target: CollectionRow;
  onClose: () => void;
  onRenamed: (updated: CollectionRow) => void;
}) {
  const [name, setName] = React.useState(target.name);
  const [description, setDescription] = React.useState(target.description ?? "");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/collections/${encodeURIComponent(target.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `Rename failed (${res.status})`);
        return;
      }
      onRenamed(json.collection as CollectionRow);
      onClose();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={() => (saving ? undefined : onClose())}
      title="Rename collection"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving || !name.trim()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 py-1">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="space-y-1.5">
          <Label htmlFor="rename-name">Name</Label>
          <Input
            id="rename-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rename-desc">Description</Label>
          <Input
            id="rename-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
          />
        </div>
      </div>
    </Dialog>
  );
}

// --- Delete dialog -----------------------------------------------------------

function DeleteDialog({
  target,
  count,
  onClose,
  onDeleted,
}: {
  target: CollectionRow;
  count: number;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const [deleting, setDeleting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onConfirm() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/collections/${encodeURIComponent(target.id)}`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `Delete failed (${res.status})`);
        return;
      }
      onDeleted(target.id);
      onClose();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog
      open
      onClose={() => (deleting ? undefined : onClose())}
      title="Delete collection?"
      description={`“${target.name}” will be removed. Its ${count} document${
        count === 1 ? "" : "s"
      } stay in the knowledge base but lose this collection tag. This cannot be undone.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={deleting}>
            {deleting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            )}
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </>
      }
    >
      {error && (
        <div className="py-1">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </Dialog>
  );
}

// --- Governance settings dialog ----------------------------------------------

const SOURCE_TYPES = ["document", "call_score", "coaching", "transcript"] as const;

function GovernanceDialog({
  target,
  onClose,
  onSaved,
}: {
  target: CollectionRow;
  onClose: () => void;
  onSaved: (id: string, settings: CollectionSettings) => void;
}) {
  const init = target.settings ?? {};
  const [owner, setOwner] = React.useState(init.owner ?? "");
  const [accessLevelV, setAccessLevelV] = React.useState(init.access_level ?? "team");
  const [modes, setModes] = React.useState<Set<string>>(() => new Set(init.allowed_work_modes ?? []));
  const [reviewDays, setReviewDays] = React.useState(init.review_interval_days?.toString() ?? "");
  const [retentionDays, setRetentionDays] = React.useState(init.retention_days?.toString() ?? "");
  const [defaultSource, setDefaultSource] = React.useState(init.default_source_type ?? "");
  const [ceoCopilot, setCeoCopilot] = React.useState(init.ceo_copilot_eligible !== false);
  const [employeeChat, setEmployeeChat] = React.useState(init.employee_chat_eligible !== false);
  const [clientFacing, setClientFacing] = React.useState(init.client_facing_eligible === true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function toggleMode(id: string) {
    setModes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onSave() {
    setSaving(true);
    setError(null);
    const settings: CollectionSettings = {
      owner: owner.trim() || undefined,
      access_level: accessLevelV,
      allowed_work_modes: [...modes],
      review_interval_days: reviewDays ? Math.max(0, parseInt(reviewDays, 10)) : null,
      retention_days: retentionDays ? Math.max(0, parseInt(retentionDays, 10)) : null,
      default_source_type: defaultSource || undefined,
      ceo_copilot_eligible: ceoCopilot,
      employee_chat_eligible: employeeChat,
      client_facing_eligible: clientFacing,
    };
    try {
      const res = await fetch(`/api/admin/collections/${encodeURIComponent(target.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `Save failed (${res.status})`);
        return;
      }
      onSaved(target.id, settings);
      onClose();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setSaving(false);
    }
  }

  const selectCls =
    "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <Dialog
      open
      onClose={() => (saving ? undefined : onClose())}
      title={`Governance — “${target.name}”`}
      description="Who owns this knowledge, who can retrieve it, and how it's reviewed and retained."
      className="max-w-2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ShieldCheck className="h-4 w-4" aria-hidden="true" />}
            {saving ? "Saving…" : "Save governance"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 py-1">
        {error && <Alert tone="danger">{error}</Alert>}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="gov-owner">Owner</Label>
            <Input id="gov-owner" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="e.g. Afra" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gov-access">Access level</Label>
            <select id="gov-access" className={selectCls} value={accessLevelV} onChange={(e) => setAccessLevelV(e.target.value)}>
              {ACCESS_LEVELS.map((a) => (
                <option key={a.value} value={a.value}>{a.label} — {a.scope}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Allowed work modes</Label>
          <p className="text-xs text-muted-foreground">Which chatbot personas may retrieve from this collection. None ticked = no restriction.</p>
          <div className="flex flex-wrap gap-2">
            {WORK_MODES.map((m) => {
              const on = modes.has(m);
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => toggleMode(m)}
                  className={
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors " +
                    (on ? "border-accent bg-accent/10 text-accent" : "border-border text-muted-foreground hover:bg-surface-muted")
                  }
                >
                  {MODE_LABELS[m]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="gov-review">Review interval (days)</Label>
            <Input id="gov-review" type="number" min={0} value={reviewDays} onChange={(e) => setReviewDays(e.target.value)} placeholder="e.g. 90" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gov-retention">Retention (days)</Label>
            <Input id="gov-retention" type="number" min={0} value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} placeholder="blank = keep" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gov-source">Default source type</Label>
            <select id="gov-source" className={selectCls} value={defaultSource} onChange={(e) => setDefaultSource(e.target.value)}>
              <option value="">Any</option>
              {SOURCE_TYPES.map((t) => (
                <option key={t} value={t}>{sourceLabel(t)}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-border p-3">
          <p className="text-sm font-medium">Eligible for</p>
          <Check id="gov-copilot" label="CEO Copilot (executive mode)" checked={ceoCopilot} onChange={setCeoCopilot} />
          <Check id="gov-team" label="General employee chat" checked={employeeChat} onChange={setEmployeeChat} />
          <Check id="gov-client" label="Client-facing generation" checked={clientFacing} onChange={setClientFacing} />
        </div>
      </div>
    </Dialog>
  );
}

function Check({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2.5 text-sm">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-border accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {label}
    </label>
  );
}

// --- Manage-documents dialog (assign / unassign) -----------------------------

function ManageDocumentsDialog({
  target,
  documents,
  memberIds,
  onClose,
  onChange,
}: {
  target: CollectionRow;
  documents: DocumentOption[];
  memberIds: string[];
  onClose: () => void;
  onChange: (documentId: string, isMember: boolean) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const memberSet = React.useMemo(() => new Set(memberIds), [memberIds]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return documents;
    return documents.filter((d) => (d.title ?? "untitled").toLowerCase().includes(q));
  }, [documents, query]);

  async function toggle(doc: DocumentOption, nextMember: boolean) {
    setPendingId(doc.id);
    setError(null);
    const base = `/api/admin/collections/${encodeURIComponent(target.id)}/documents`;
    try {
      const res = nextMember
        ? await fetch(base, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ document_id: doc.id }),
          })
        : await fetch(`${base}?document_id=${encodeURIComponent(doc.id)}`, {
            method: "DELETE",
          });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `Update failed (${res.status})`);
        return;
      }
      onChange(doc.id, nextMember);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Documents in “${target.name}”`}
      description="Tick a document to add it to this collection; untick to remove it. Chunk scope updates automatically."
      className="max-w-2xl"
      footer={
        <Button variant="outline" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-3 py-1">
        {error && <Alert tone="danger">{error}</Alert>}

        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search documents…"
          aria-label="Search documents"
        />

        {filtered.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No documents match your search.
          </p>
        ) : (
          <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {filtered.map((doc) => {
              const isMember = memberSet.has(doc.id);
              const busy = pendingId === doc.id;
              const inputId = `doc-${doc.id}`;
              return (
                <li key={doc.id} className="flex items-center gap-3 px-3 py-2.5">
                  <input
                    id={inputId}
                    type="checkbox"
                    className="h-4 w-4 shrink-0 rounded border-border accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                    checked={isMember}
                    disabled={busy}
                    onChange={(e) => toggle(doc, e.target.checked)}
                  />
                  <label htmlFor={inputId} className="min-w-0 flex-1 cursor-pointer">
                    <span className="block truncate text-sm font-medium">
                      {doc.title || "Untitled"}
                    </span>
                  </label>
                  <Badge tone="neutral">{sourceLabel(doc.source_type)}</Badge>
                  {busy && (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
