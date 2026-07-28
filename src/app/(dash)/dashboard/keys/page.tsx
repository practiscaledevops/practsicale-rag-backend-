"use client";

// API Keys — list, mint, and revoke scoped keys for consumer apps.
//
// A key is scoped by capability (chat / retrieve / generate), by data type
// (source_type), and optionally down to named data sources and collections. The
// plaintext secret is returned by the server exactly ONCE at creation and shown
// here in a reveal step; it is never retrievable again.
//
// This page never resolves org or touches the DB directly — it calls the
// admin API (/api/admin/keys), which enforces the session + org server-side.

import * as React from "react";
import { KeyRound, Plus, Copy, Check, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Badge } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Table, THead, TBody, Tr, Th, Td } from "@/components/ui/Table";

// ---------------------------------------------------------------------------
// Types + labels
// ---------------------------------------------------------------------------

interface ApiKey {
  id: string;
  name: string | null;
  key_prefix: string | null;
  capabilities: string[];
  source_types: string[];
  data_source_ids: string[];
  collection_ids: string[];
  rate_limit_per_min: number;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  request_count: number;
  created_at: string;
}

interface DataSource {
  id: string;
  name: string;
  source_type: string;
}
interface Collection {
  id: string;
  name: string;
}

const CAPABILITIES = ["chat", "retrieve", "generate"] as const;
const SOURCE_TYPES = ["call_score", "coaching", "document", "transcript"] as const;

const CAPABILITY_LABELS: Record<string, string> = {
  chat: "Chat",
  retrieve: "Retrieve",
  generate: "Generate",
};
const SOURCE_TYPE_LABELS: Record<string, string> = {
  call_score: "Call scores",
  coaching: "Coaching",
  document: "Documents",
  transcript: "Transcripts",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

type Status = { label: string; tone: "success" | "danger" | "warning" | "neutral" };
function keyStatus(k: ApiKey): Status {
  if (k.revoked_at) return { label: "Revoked", tone: "danger" };
  if (k.expires_at && new Date(k.expires_at) <= new Date())
    return { label: "Expired", tone: "warning" };
  return { label: "Active", tone: "success" };
}

// ---------------------------------------------------------------------------
// A labelled checkbox used across the scope pickers.
// ---------------------------------------------------------------------------

function CheckRow({
  id,
  checked,
  onChange,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-muted"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-border text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <span className="min-w-0">{children}</span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function KeysPage() {
  const [keys, setKeys] = React.useState<ApiKey[]>([]);
  const [dataSources, setDataSources] = React.useState<DataSource[]>([]);
  const [collections, setCollections] = React.useState<Collection[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [revokingId, setRevokingId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/admin/keys");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load keys");
      setKeys(data.keys ?? []);
      setDataSources(data.dataSources ?? []);
      setCollections(data.collections ?? []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load keys");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function revoke(id: string) {
    if (!window.confirm("Revoke this key? Apps using it will immediately lose access.")) return;
    setRevokingId(id);
    try {
      const res = await fetch(`/api/admin/keys?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Revoke failed");
      // Reflect the new state without a full reload.
      setKeys((prev) =>
        prev.map((k) => (k.id === id ? { ...k, revoked_at: new Date().toISOString() } : k))
      );
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Revoke failed");
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="API Keys"
        description="Scoped secret keys that consumer apps use to read the Brain through its public API."
        actions={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Create key
          </Button>
        }
      />

      {loadError && (
        <Alert tone="danger" title="Couldn't load keys" className="mb-4">
          {loadError}
        </Alert>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : keys.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No API keys yet"
          description="Create a scoped key to let a consumer app read the Brain."
          action={
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Create key
            </Button>
          }
        />
      ) : (
        <Card>
          <Table>
            <THead>
              <tr>
                <Th>Name</Th>
                <Th>Key</Th>
                <Th>Capabilities</Th>
                <Th>Data types</Th>
                <Th>Created</Th>
                <Th>Last used</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </THead>
            <TBody>
              {keys.map((k) => {
                const status = keyStatus(k);
                return (
                  <Tr key={k.id}>
                    <Td className="font-medium">{k.name ?? "Untitled"}</Td>
                    <Td>
                      <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs">
                        {k.key_prefix ?? "—"}…
                      </code>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {k.capabilities.map((c) => (
                          <Badge key={c} tone="accent">
                            {CAPABILITY_LABELS[c] ?? c}
                          </Badge>
                        ))}
                      </div>
                    </Td>
                    <Td>
                      {k.source_types.length === 0 ? (
                        <span className="text-xs text-muted-foreground">All types</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {k.source_types.map((s) => (
                            <Badge key={s}>{SOURCE_TYPE_LABELS[s] ?? s}</Badge>
                          ))}
                        </div>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-muted-foreground">
                      {formatDate(k.created_at)}
                    </Td>
                    <Td className="whitespace-nowrap text-muted-foreground">
                      {formatDate(k.last_used_at)}
                    </Td>
                    <Td>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </Td>
                    <Td className="text-right">
                      {k.revoked_at ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => revoke(k.id)}
                          disabled={revokingId === k.id}
                        >
                          {revokingId === k.id ? "Revoking…" : "Revoke"}
                        </Button>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        </Card>
      )}

      {dialogOpen && (
        <CreateKeyDialog
          dataSources={dataSources}
          collections={collections}
          onClose={() => setDialogOpen(false)}
          onCreated={(key) => setKeys((prev) => [key, ...prev])}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create-key dialog: a scope form, then a one-time secret reveal.
// ---------------------------------------------------------------------------

function CreateKeyDialog({
  dataSources,
  collections,
  onClose,
  onCreated,
}: {
  dataSources: DataSource[];
  collections: Collection[];
  onClose: () => void;
  onCreated: (key: ApiKey) => void;
}) {
  const [name, setName] = React.useState("");
  const [caps, setCaps] = React.useState<Set<string>>(new Set(["chat"]));
  const [types, setTypes] = React.useState<Set<string>>(new Set());
  const [dsIds, setDsIds] = React.useState<Set<string>>(new Set());
  const [colIds, setColIds] = React.useState<Set<string>>(new Set());
  const [expiresAt, setExpiresAt] = React.useState("");

  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [secret, setSecret] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  function toggle(setter: React.Dispatch<React.SetStateAction<Set<string>>>, value: string) {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  async function submit() {
    if (!name.trim()) {
      setError("A key name is required");
      return;
    }
    if (caps.size === 0) {
      setError("Select at least one capability");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          capabilities: [...caps],
          source_types: [...types],
          data_source_ids: [...dsIds],
          collection_ids: [...colIds],
          expires_at: expiresAt || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create key");
      onCreated(data.key as ApiKey);
      setSecret(data.secret as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create key");
    } finally {
      setSubmitting(false);
    }
  }

  async function copy() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked — the secret is visible for manual copy.
    }
  }

  // ---- Reveal step: the secret is shown once, then unrecoverable. ----
  if (secret) {
    return (
      <Dialog
        open
        onClose={onClose}
        title="Copy your key now"
        description="This is the only time the full secret is shown. Store it somewhere safe."
        footer={<Button onClick={onClose}>Done</Button>}
      >
        <div className="space-y-3 pb-2">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-border bg-surface-muted px-3 py-2 font-mono text-xs">
              {secret}
            </code>
            <Button variant="outline" size="sm" onClick={copy} aria-label="Copy key">
              {copied ? (
                <Check className="h-4 w-4 text-success" aria-hidden="true" />
              ) : (
                <Copy className="h-4 w-4" aria-hidden="true" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <Alert tone="warning" title="Store it securely">
            The Brain keeps only a hash of this key. If you lose it, revoke it and create a new one.
          </Alert>
        </div>
      </Dialog>
    );
  }

  // ---- Form step. ----
  return (
    <Dialog
      open
      onClose={onClose}
      title="Create API key"
      description="Grant only the capabilities and data this app needs."
      className="max-w-xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? "Creating…" : "Create key"}
          </Button>
        </>
      }
    >
      <div className="max-h-[60vh] space-y-5 overflow-y-auto pb-2">
        {error && <Alert tone="danger">{error}</Alert>}

        <div className="space-y-1.5">
          <Label htmlFor="key-name">Name</Label>
          <Input
            id="key-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Chatbot (production)"
            autoFocus
          />
        </div>

        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">Capabilities</legend>
          <p className="text-xs text-muted-foreground">What this key is allowed to do.</p>
          <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-3">
            {CAPABILITIES.map((c) => (
              <CheckRow
                key={c}
                id={`cap-${c}`}
                checked={caps.has(c)}
                onChange={() => toggle(setCaps, c)}
              >
                {CAPABILITY_LABELS[c]}
              </CheckRow>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">Data types</legend>
          <p className="text-xs text-muted-foreground">
            Restrict to specific source types. Leave all unchecked to allow every type.
          </p>
          <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2">
            {SOURCE_TYPES.map((s) => (
              <CheckRow
                key={s}
                id={`type-${s}`}
                checked={types.has(s)}
                onChange={() => toggle(setTypes, s)}
              >
                {SOURCE_TYPE_LABELS[s]}
              </CheckRow>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">Data sources</legend>
          <p className="text-xs text-muted-foreground">
            Optionally limit to specific registered sources. None selected = all in scope.
          </p>
          {dataSources.length === 0 ? (
            <p className="text-xs text-muted-foreground">No data sources registered yet.</p>
          ) : (
            <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2">
              {dataSources.map((d) => (
                <CheckRow
                  key={d.id}
                  id={`ds-${d.id}`}
                  checked={dsIds.has(d.id)}
                  onChange={() => toggle(setDsIds, d.id)}
                >
                  {d.name}{" "}
                  <span className="text-xs text-muted-foreground">
                    ({SOURCE_TYPE_LABELS[d.source_type] ?? d.source_type})
                  </span>
                </CheckRow>
              ))}
            </div>
          )}
        </fieldset>

        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">Collections</legend>
          <p className="text-xs text-muted-foreground">
            Optionally limit to specific collections. None selected = all in scope.
          </p>
          {collections.length === 0 ? (
            <p className="text-xs text-muted-foreground">No collections created yet.</p>
          ) : (
            <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2">
              {collections.map((c) => (
                <CheckRow
                  key={c.id}
                  id={`col-${c.id}`}
                  checked={colIds.has(c.id)}
                  onChange={() => toggle(setColIds, c.id)}
                >
                  {c.name}
                </CheckRow>
              ))}
            </div>
          )}
        </fieldset>

        <div className="space-y-1.5">
          <Label htmlFor="key-expiry">Expiry (optional)</Label>
          <Input
            id="key-expiry"
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Leave blank for a key that never expires.
          </p>
        </div>

        {caps.size === 0 && (
          <div className="flex items-center gap-2 text-xs text-warning">
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
            A key with no capability can't do anything.
          </div>
        )}
      </div>
    </Dialog>
  );
}
