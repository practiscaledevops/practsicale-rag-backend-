"use client";

// Connectors — register external integrations (MCP servers or third-party HTTP
// APIs) and grant them to specific scoped keys.
//
// The Brain holds a connector's config and a REFERENCE to where its secret lives
// (auth_secret_ref); consumer apps never see the secret itself. A grant links a
// connector to an api_key, so only apps holding that key may use it.
//
// This page calls the admin API (/api/admin/connectors), which enforces the
// session + org server-side. It never resolves org or touches the DB directly.

import * as React from "react";
import { Globe, KeyRound, Plug, Plus, Trash2 } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  useConfirm,
} from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { statusTone } from "@/lib/ui-labels";

// ---------------------------------------------------------------------------
// Types + labels
// ---------------------------------------------------------------------------

interface Grant {
  id: string;
  api_key_id: string;
  key_name: string | null;
  key_prefix: string | null;
}

interface Connector {
  id: string;
  name: string;
  slug: string | null;
  kind: string;
  config: Record<string, unknown>;
  auth_secret_ref: string | null;
  is_active: boolean;
  created_at: string;
  grants: Grant[];
}

interface ApiKeyRef {
  id: string;
  name: string | null;
  key_prefix: string | null;
  revoked_at: string | null;
}

const KINDS = ["mcp", "http_api"] as const;
const KIND_LABELS: Record<string, string> = {
  mcp: "MCP server",
  http_api: "HTTP API",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ConnectorsPage() {
  const [connectors, setConnectors] = React.useState<Connector[]>([]);
  const [apiKeys, setApiKeys] = React.useState<ApiKeyRef[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/admin/connectors");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load connectors");
      setConnectors(data.connectors ?? []);
      setApiKeys(data.apiKeys ?? []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load connectors");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Merge a granted link into local state without a full reload.
  function addGrant(connectorId: string, grant: Grant) {
    setConnectors((prev) =>
      prev.map((c) =>
        c.id === connectorId ? { ...c, grants: [...c.grants, grant] } : c
      )
    );
  }
  function removeGrant(connectorId: string, grantId: string) {
    setConnectors((prev) =>
      prev.map((c) =>
        c.id === connectorId
          ? { ...c, grants: c.grants.filter((g) => g.id !== grantId) }
          : c
      )
    );
  }

  return (
    <div>
      <PageHeader
        title="Connectors"
        description="Outside tools and APIs that API keys can be granted."
        actions={
          <Button size="toolbar" onClick={() => setDialogOpen(true)}>
            <Plus size={14} aria-hidden />
            New connector
          </Button>
        }
      />

      {loadError && (
        <Alert tone="danger" title="Couldn't load connectors" className="mb-4">
          <span className="text-danger">{loadError}</span>
        </Alert>
      )}

      {loading ? (
        <div role="status" className="space-y-4">
          <span className="sr-only">Loading connectors…</span>
          {[0, 1].map((i) => (
            <Card key={i} aria-hidden className="p-4">
              <div className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 shrink-0" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-64 max-w-full" />
                </div>
              </div>
              <Skeleton className="mt-4 h-9 w-full rounded-xl" />
            </Card>
          ))}
        </div>
      ) : connectors.length === 0 ? (
        !loadError && (
          <EmptyState
            icon={Plug}
            title="No connectors yet"
            description="Register an MCP server or HTTP API to grant it to consumer apps."
            action={
              <Button size="toolbar" onClick={() => setDialogOpen(true)}>
                <Plus size={14} aria-hidden />
                New connector
              </Button>
            }
          />
        )
      ) : (
        <div className="space-y-4">
          {connectors.map((c) => (
            <ConnectorCard
              key={c.id}
              connector={c}
              apiKeys={apiKeys}
              onGranted={(g) => addGrant(c.id, g)}
              onUngranted={(grantId) => removeGrant(c.id, grantId)}
            />
          ))}
        </div>
      )}

      {dialogOpen && (
        <CreateConnectorDialog
          onClose={() => setDialogOpen(false)}
          onCreated={(connector) => setConnectors((prev) => [connector, ...prev])}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One connector: details + grant management.
// ---------------------------------------------------------------------------

function ConnectorCard({
  connector,
  apiKeys,
  onGranted,
  onUngranted,
}: {
  connector: Connector;
  apiKeys: ApiKeyRef[];
  onGranted: (grant: Grant) => void;
  onUngranted: (grantId: string) => void;
}) {
  const [selectedKey, setSelectedKey] = React.useState("");
  const [granting, setGranting] = React.useState(false);
  const [busyGrant, setBusyGrant] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  // Keys that can still be granted: active and not already linked.
  const grantedIds = new Set(connector.grants.map((g) => g.api_key_id));
  const available = apiKeys.filter((k) => !k.revoked_at && !grantedIds.has(k.id));
  const KindIcon = connector.kind === "http_api" ? Globe : Plug;

  async function grant() {
    if (!selectedKey) return;
    setGranting(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/connectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "grant",
          connector_id: connector.id,
          api_key_id: selectedKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Grant failed");
      const key = apiKeys.find((k) => k.id === selectedKey);
      if (data.grant) {
        onGranted({
          id: data.grant.id,
          api_key_id: selectedKey,
          key_name: key?.name ?? null,
          key_prefix: key?.key_prefix ?? null,
        });
      }
      setSelectedKey("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Grant failed");
    } finally {
      setGranting(false);
    }
  }

  async function ungrant(grantId: string) {
    setBusyGrant(grantId);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/connectors?grant_id=${encodeURIComponent(grantId)}`,
        { method: "DELETE" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to remove grant");
      onUngranted(grantId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove grant");
    } finally {
      setBusyGrant(null);
    }
  }

  async function confirmUngrant(g: Grant) {
    const keyName = g.key_name ?? "Untitled key";
    const ok = await confirm({
      title: `Remove access for ${keyName}?`,
      description: `Apps using this key can no longer use ${connector.name}. You can grant it again later.`,
      confirmLabel: "Remove access",
      tone: "danger",
    });
    if (ok) await ungrant(g.id);
  }

  return (
    <Card>
      <div className="flex items-start gap-3 px-4 pt-4">
        <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
          <KindIcon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">{connector.name}</h2>
            <Badge tone="neutral">{KIND_LABELS[connector.kind] ?? connector.kind}</Badge>
            <Badge tone={statusTone(connector.is_active ? "active" : "inactive")}>
              {connector.is_active ? "Active" : "Inactive"}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Added {fmtDate(connector.created_at)}
            {connector.auth_secret_ref && (
              <>
                {" · secret ref "}
                <code className="rounded-md bg-surface-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                  {connector.auth_secret_ref}
                </code>
              </>
            )}
          </p>
        </div>
      </div>

      <div className="space-y-4 p-4">
        {/* Config preview — read-only, treated as data. */}
        {Object.keys(connector.config ?? {}).length > 0 && (
          <pre className="max-h-40 overflow-auto rounded-xl border border-border bg-surface-muted p-3 font-mono text-xs text-foreground">
            {JSON.stringify(connector.config, null, 2)}
          </pre>
        )}

        {/* Grants */}
        <div className="border-t border-border pt-4">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">Granted keys</h3>

          {error && (
            <Alert tone="danger" className="mb-3">
              {error}
            </Alert>
          )}

          {connector.grants.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">Not granted to any key yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {connector.grants.map((g) => (
                <li
                  key={g.id}
                  className="flex items-center justify-between gap-3 rounded-xl bg-surface-muted px-3 py-1.5"
                >
                  <span className="flex min-w-0 items-center gap-2 text-[13px]">
                    <KeyRound size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate font-medium text-foreground">{g.key_name ?? "Untitled key"}</span>
                    {g.key_prefix && (
                      <code className="rounded-md bg-surface px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                        {g.key_prefix}…
                      </code>
                    )}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => confirmUngrant(g)}
                    disabled={busyGrant === g.id}
                    loading={busyGrant === g.id}
                    aria-label={`Remove grant for ${g.key_name ?? "key"}`}
                  >
                    {busyGrant !== g.id && <Trash2 size={14} aria-hidden />}
                    {busyGrant === g.id ? "Removing…" : "Remove"}
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {/* Grant to a new key */}
          {available.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <Field label="Grant to a key" className="min-w-0 flex-1 sm:max-w-sm">
                <Select
                  id={`grant-${connector.id}`}
                  density="compact"
                  value={selectedKey}
                  onChange={(e) => setSelectedKey(e.target.value)}
                  placeholder="Select a key…"
                  options={available.map((k) => ({
                    value: k.id,
                    label: (k.name ?? "Untitled key") + (k.key_prefix ? ` (${k.key_prefix}…)` : ""),
                  }))}
                />
              </Field>
              <Button size="toolbar" onClick={grant} disabled={!selectedKey || granting} loading={granting}>
                {granting ? "Granting…" : "Grant"}
              </Button>
            </div>
          ) : (
            connector.grants.length === 0 && (
              <p className="mt-3 text-xs text-muted-foreground">
                Create an API key first to grant this connector.
              </p>
            )
          )}
        </div>
      </div>
      {dialog}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Create-connector dialog.
// ---------------------------------------------------------------------------

function CreateConnectorDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (connector: Connector) => void;
}) {
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<(typeof KINDS)[number]>("mcp");
  const [config, setConfig] = React.useState("{\n  \n}");
  const [authRef, setAuthRef] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    if (!name.trim()) {
      setError("A connector name is required");
      return;
    }
    // Validate config JSON client-side for a fast, clear error.
    let parsedConfig: unknown = {};
    if (config.trim() !== "") {
      try {
        parsedConfig = JSON.parse(config);
      } catch {
        setError("Config must be valid JSON");
        return;
      }
      if (
        typeof parsedConfig !== "object" ||
        parsedConfig === null ||
        Array.isArray(parsedConfig)
      ) {
        setError("Config must be a JSON object");
        return;
      }
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/connectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          kind,
          config: parsedConfig,
          auth_secret_ref: authRef.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create connector");
      onCreated(data.connector as Connector);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create connector");
    } finally {
      setSubmitting(false);
    }
  }

  const placeholder =
    kind === "mcp"
      ? '{\n  "server_url": "https://...",\n  "transport": "sse"\n}'
      : '{\n  "base_url": "https://...",\n  "tools": []\n}';

  return (
    <Dialog
      open
      onClose={onClose}
      title="New connector"
      description="Register an external integration. Store secrets by reference, never inline."
      size="lg"
      closeOnBackdrop={false}
      dismissible={!submitting}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} loading={submitting}>
            {submitting ? "Creating…" : "Create connector"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 pb-1">
        {error && <Alert tone="danger">{error}</Alert>}

        <Field label="Name">
          <Input
            id="conn-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Higgsfield image API"
            autoFocus
          />
        </Field>

        <Field label="Kind">
          <Select
            id="conn-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}
            options={KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }))}
          />
        </Field>

        <Field
          label="Config (JSON)"
          hint={
            kind === "mcp"
              ? "e.g. server_url and transport for an MCP server."
              : "e.g. base_url and the tools this API exposes."
          }
        >
          <Textarea
            id="conn-config"
            mono
            value={config}
            onChange={(e) => setConfig(e.target.value)}
            rows={6}
            spellCheck={false}
            placeholder={placeholder}
          />
        </Field>

        <Field
          label="Auth secret reference (optional)"
          hint="The env var or vault key that holds the secret, never the secret itself."
        >
          <Input
            id="conn-secret"
            value={authRef}
            onChange={(e) => setAuthRef(e.target.value)}
            placeholder="e.g. HIGGSFIELD_API_KEY"
            className="font-mono"
          />
        </Field>
      </div>
    </Dialog>
  );
}
