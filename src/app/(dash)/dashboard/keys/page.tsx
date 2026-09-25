"use client";

// API keys — list, mint, and revoke scoped keys for consumer apps.
//
// A key is scoped by capability (chat / retrieve / generate), by source type
// (source_type), and optionally down to named data sources and collections. The
// plaintext secret is returned by the server exactly ONCE at creation and shown
// here in a reveal step; it is never retrievable again.
//
// This page never resolves org or touches the DB directly — it calls the
// admin API (/api/admin/keys), which enforces the session + org server-side.

import * as React from "react";
import { Check, Copy, KeyRound, Plus, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Field } from "@/components/ui/Field";
import { Checkbox } from "@/components/ui/Checkbox";
import { Badge } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import { Dialog } from "@/components/ui/Dialog";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Table, THead, TBody, Tr, Th, Td, TableCard, TableSkeletonRows } from "@/components/ui/Table";
import { fmtDate, fmtInt } from "@/lib/format";
import { sourceTypeLabel } from "@/lib/ui-labels";

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

type Status = { label: string; tone: "success" | "danger" | "warning" | "neutral" };
function keyStatus(k: ApiKey): Status {
  // Revoked is a normal, historical admin state (neutral), not a failure.
  if (k.revoked_at) return { label: "Revoked", tone: "neutral" };
  if (k.expires_at && new Date(k.expires_at) <= new Date())
    return { label: "Expired", tone: "warning" };
  return { label: "Active", tone: "success" };
}

const plural = (n: number, one: string, many: string) => `${fmtInt(n)} ${n === 1 ? one : many}`;

/** "All data sources" or "2 data sources", with the names for a tooltip. */
function scopeLimit(
  ids: string[],
  lookup: Map<string, string>,
  one: string,
  many: string
): { text: string; title?: string } {
  if (ids.length === 0) return { text: `All ${many}` };
  const names = ids.map((id) => lookup.get(id) ?? "Unknown");
  return { text: plural(ids.length, one, many), title: names.join(", ") };
}

// ---------------------------------------------------------------------------
// Scope picker pieces
// ---------------------------------------------------------------------------

/** A labelled checkbox row (the chatbot checklist recipe). */
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
      className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-[13px] text-foreground transition-colors hover:bg-surface-muted"
    >
      <Checkbox id={id} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0 truncate">{children}</span>
    </label>
  );
}

/** A group of scope checkboxes with a legend and a hint. */
function ScopeFieldset({
  legend,
  hint,
  children,
}: {
  legend: string;
  hint: string;
  children: React.ReactNode;
}) {
  const hintId = React.useId();
  return (
    <fieldset aria-describedby={hintId} className="min-w-0">
      <legend className="text-xs font-medium text-muted-foreground">{legend}</legend>
      <p id={hintId} className="mb-1 mt-0.5 text-xs text-muted-foreground">
        {hint}
      </p>
      {children}
    </fieldset>
  );
}

/** Copy button with brief "Copied" feedback (the chatbot CopyButton behaviour). */
const CopyButton = React.forwardRef<HTMLButtonElement, { value: string; label: string }>(
  function CopyButton({ value, label }, ref) {
    const [state, setState] = React.useState<"idle" | "copied" | "failed">("idle");
    const timer = React.useRef<number | null>(null);
    React.useEffect(
      () => () => {
        if (timer.current) window.clearTimeout(timer.current);
      },
      []
    );

    async function copy() {
      let ok = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
          ok = true;
        }
      } catch {
        // Clipboard blocked — the secret stays visible for a manual copy.
      }
      setState(ok ? "copied" : "failed");
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setState("idle"), 1500);
    }

    const text = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy";
    return (
      <Button
        ref={ref}
        variant="secondary"
        size="toolbar"
        onClick={() => void copy()}
        aria-label={state === "idle" ? label : text}
        className="shrink-0"
      >
        {state === "copied" ? (
          <Check size={14} className="text-success" aria-hidden />
        ) : (
          <Copy size={14} aria-hidden />
        )}
        <span aria-live="polite">{text}</span>
      </Button>
    );
  }
);

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const COLS = 8;

export default function KeysPage() {
  const [keys, setKeys] = React.useState<ApiKey[]>([]);
  const [dataSources, setDataSources] = React.useState<DataSource[]>([]);
  const [collections, setCollections] = React.useState<Collection[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [revokingId, setRevokingId] = React.useState<string | null>(null);
  const [revokeError, setRevokeError] = React.useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  const newKeyRef = React.useRef<HTMLButtonElement>(null);

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
    const ok = await confirm({
      title: "Revoke this key?",
      description: "Apps using it will immediately lose access.",
      tone: "danger",
      confirmLabel: "Revoke key",
    });
    if (!ok) return;
    setRevokeError(null);
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
      // The row's Revoke button is replaced by "—": move focus to a stable control.
      newKeyRef.current?.focus();
    } catch (e) {
      setRevokeError(e instanceof Error ? e.message : "Revoke failed");
    } finally {
      setRevokingId(null);
    }
  }

  const dsNames = React.useMemo(() => new Map(dataSources.map((d) => [d.id, d.name])), [dataSources]);
  const colNames = React.useMemo(() => new Map(collections.map((c) => [c.id, c.name])), [collections]);
  const activeCount = keys.filter((k) => keyStatus(k).tone === "success").length;

  const head = (
    <THead>
      <tr>
        <Th>Name</Th>
        <Th>Capabilities</Th>
        <Th>Scope</Th>
        <Th numeric>Requests</Th>
        <Th numeric>Rate limit</Th>
        <Th>Last used</Th>
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
        title="API keys"
        description="Scoped keys that apps like the chatbot use to read the Brain."
        actions={
          <Button ref={newKeyRef} size="toolbar" onClick={() => setDialogOpen(true)}>
            <Plus size={14} aria-hidden />
            New key
          </Button>
        }
      />

      {loadError && (
        <Alert tone="danger" className="mb-4">
          <span className="font-medium">Couldn&apos;t load keys.</span> {loadError}
        </Alert>
      )}

      {revokeError && (
        <Alert tone="danger" className="mb-4" onDismiss={() => setRevokeError(null)}>
          <span className="font-medium">Couldn&apos;t revoke the key.</span> {revokeError}
        </Alert>
      )}

      {loading ? (
        <TableCard>
          <Table minWidth={960} caption="API keys" aria-busy="true">
            {head}
            <TBody>
              <TableSkeletonRows rows={4} cols={COLS} />
            </TBody>
          </Table>
        </TableCard>
      ) : keys.length === 0 ? (
        loadError ? null : (
          <EmptyState
            icon={KeyRound}
            title="No API keys yet"
            description="Create a scoped key to let a consumer app read the Brain."
            action={
              <Button size="toolbar" onClick={() => setDialogOpen(true)}>
                <Plus size={14} aria-hidden />
                New key
              </Button>
            }
          />
        )
      ) : (
        <TableCard
          title="Keys"
          meta={`${fmtInt(activeCount)} active · ${plural(keys.length, "key", "keys")} in total`}
        >
          <Table minWidth={960} caption="API keys">
            {head}
            <TBody>
              {keys.map((k) => {
                const status = keyStatus(k);
                const ds = scopeLimit(k.data_source_ids, dsNames, "data source", "data sources");
                const cols = scopeLimit(k.collection_ids, colNames, "collection", "collections");
                return (
                  <Tr key={k.id}>
                    <Td>
                      <div className="font-medium">{k.name ?? "Untitled"}</div>
                      <code className="font-mono text-xs text-muted-foreground">{k.key_prefix ?? "—"}…</code>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {k.capabilities.map((c) => (
                          <Badge key={c} tone="neutral">
                            {CAPABILITY_LABELS[c] ?? c}
                          </Badge>
                        ))}
                      </div>
                    </Td>
                    <Td>
                      {k.source_types.length === 0 ? (
                        <span className="text-[13px] text-foreground">All source types</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {k.source_types.map((s) => (
                            <Badge key={s} tone="neutral">
                              {sourceTypeLabel(s)}
                            </Badge>
                          ))}
                        </div>
                      )}
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        <span title={ds.title}>{ds.text}</span> · <span title={cols.title}>{cols.text}</span>
                      </div>
                    </Td>
                    <Td numeric>{fmtInt(k.request_count)}</Td>
                    <Td numeric>{fmtInt(k.rate_limit_per_min)}/min</Td>
                    <Td className="whitespace-nowrap">
                      <div>{k.last_used_at ? fmtDate(k.last_used_at) : "Never"}</div>
                      <div className="text-xs text-muted-foreground">Created {fmtDate(k.created_at)}</div>
                    </Td>
                    <Td className="whitespace-nowrap">
                      <Badge tone={status.tone}>{status.label}</Badge>
                      {k.expires_at && !k.revoked_at && (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {status.label === "Expired" ? "Expired" : "Expires"} {fmtDate(k.expires_at)}
                        </div>
                      )}
                    </Td>
                    <Td className="text-right">
                      {k.revoked_at ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <Button
                          variant="danger-secondary"
                          size="sm"
                          onClick={() => void revoke(k.id)}
                          loading={revokingId === k.id}
                        >
                          {revokingId === k.id ? "Revoking…" : "Revoke"}
                          <span className="sr-only"> {k.name ?? "key"}</span>
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

      {dialogOpen && (
        <CreateKeyDialog
          dataSources={dataSources}
          collections={collections}
          onClose={() => setDialogOpen(false)}
          onCreated={(key) => setKeys((prev) => [key, ...prev])}
          returnFocus={() => newKeyRef.current}
        />
      )}

      {dialog}
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
  returnFocus,
}: {
  dataSources: DataSource[];
  collections: Collection[];
  onClose: () => void;
  onCreated: (key: ApiKey) => void;
  returnFocus?: () => HTMLElement | null;
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
  const copyRef = React.useRef<HTMLButtonElement>(null);

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

  // ---- Reveal step: the secret is shown once, then unrecoverable. It can't be
  // dismissed by Escape, a backdrop click or an X — only "I've copied it". ----
  if (secret) {
    return (
      <Dialog
        key="reveal"
        open
        onClose={onClose}
        dismissible={false}
        closeOnBackdrop={false}
        title="Copy your new key"
        description="This is the only time the full secret is shown. Store it somewhere safe."
        initialFocusRef={copyRef}
        returnFocus={returnFocus}
        footer={<Button onClick={onClose}>I&apos;ve copied it</Button>}
      >
        <div className="space-y-3">
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 break-all rounded-xl border border-border bg-surface-muted px-3 py-2 font-mono text-[13px]">
              {secret}
            </code>
            <CopyButton ref={copyRef} value={secret} label="Copy key" />
          </div>
          <Alert tone="warning" title="You won't be able to see this key again.">
            The Brain keeps only a hash of this key. If you lose it, revoke it and create a new one.
          </Alert>
        </div>
      </Dialog>
    );
  }

  // ---- Form step. ----
  return (
    <Dialog
      key="form"
      open
      onClose={onClose}
      title="Create API key"
      description="Grant only the capabilities and data this app needs."
      size="lg"
      closeOnBackdrop={false}
      dismissible={!submitting}
      returnFocus={returnFocus}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={submitting}>
            {submitting ? "Creating…" : "Create key"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error && <Alert tone="danger">{error}</Alert>}

        <Field label="Name">
          <Input
            id="key-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Chatbot (production)"
            autoFocus
          />
        </Field>

        <ScopeFieldset legend="Capabilities" hint="What this key is allowed to do.">
          <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-3">
            {CAPABILITIES.map((c) => (
              <CheckRow key={c} id={`cap-${c}`} checked={caps.has(c)} onChange={() => toggle(setCaps, c)}>
                {CAPABILITY_LABELS[c]}
              </CheckRow>
            ))}
          </div>
        </ScopeFieldset>

        <ScopeFieldset
          legend="Source types"
          hint="Restrict to specific source types. Leave all unchecked to allow every type."
        >
          <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2">
            {SOURCE_TYPES.map((s) => (
              <CheckRow key={s} id={`type-${s}`} checked={types.has(s)} onChange={() => toggle(setTypes, s)}>
                {sourceTypeLabel(s)}
              </CheckRow>
            ))}
          </div>
        </ScopeFieldset>

        <ScopeFieldset
          legend="Data sources"
          hint="Optionally limit to specific registered sources. None selected = all in scope."
        >
          {dataSources.length === 0 ? (
            <p className="px-2 text-[13px] text-muted-foreground">No data sources registered yet.</p>
          ) : (
            <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2">
              {dataSources.map((d) => (
                <CheckRow
                  key={d.id}
                  id={`ds-${d.id}`}
                  checked={dsIds.has(d.id)}
                  onChange={() => toggle(setDsIds, d.id)}
                >
                  {d.name} <span className="text-xs text-muted-foreground">({sourceTypeLabel(d.source_type)})</span>
                </CheckRow>
              ))}
            </div>
          )}
        </ScopeFieldset>

        <ScopeFieldset
          legend="Collections"
          hint="Optionally limit to specific collections. None selected = all in scope."
        >
          {collections.length === 0 ? (
            <p className="px-2 text-[13px] text-muted-foreground">No collections created yet.</p>
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
        </ScopeFieldset>

        <Field label="Expiry (optional)" hint="Leave blank for a key that never expires.">
          <Input
            id="key-expiry"
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            className="sm:w-56"
          />
        </Field>

        {caps.size === 0 && (
          <p className="flex items-center gap-2 text-xs text-warning">
            <ShieldAlert size={14} className="shrink-0" aria-hidden />
            A key with no capability can&apos;t do anything.
          </p>
        )}
      </div>
    </Dialog>
  );
}
