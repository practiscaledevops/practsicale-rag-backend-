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
import { Plug, Plus, Trash2, KeyRound } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Badge } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";

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

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

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
        description="External integrations — MCP servers and HTTP APIs — that granted keys can use."
        actions={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add connector
          </Button>
        }
      />

      {loadError && (
        <Alert tone="danger" title="Couldn't load connectors" className="mb-4">
          {loadError}
        </Alert>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : connectors.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="No connectors yet"
          description="Register an MCP server or HTTP API to grant it to consumer apps."
          action={
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add connector
            </Button>
          }
        />
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

  // Keys that can still be granted: active and not already linked.
  const grantedIds = new Set(connector.grants.map((g) => g.api_key_id));
  const available = apiKeys.filter((k) => !k.revoked_at && !grantedIds.has(k.id));

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

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold">{connector.name}</h3>
              <Badge tone="accent">{KIND_LABELS[connector.kind] ?? connector.kind}</Badge>
              {!connector.is_active && <Badge tone="warning">Inactive</Badge>}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Added {formatDate(connector.created_at)}
              {connector.auth_secret_ref && (
                <>
                  {" · secret ref "}
                  <code className="rounded bg-surface-muted px-1 py-0.5 font-mono">
                    {connector.auth_secret_ref}
                  </code>
                </>
              )}
            </p>
          </div>
        </div>

        {/* Config preview — read-only, treated as data. */}
        {Object.keys(connector.config ?? {}).length > 0 && (
          <pre className="mt-3 max-h-40 overflow-auto rounded-lg border border-border bg-surface-muted p-3 text-xs">
            {JSON.stringify(connector.config, null, 2)}
          </pre>
        )}

        {/* Grants */}
        <div className="mt-4 border-t border-border pt-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Granted keys
          </p>

          {error && (
            <Alert tone="danger" className="mb-3">
              {error}
            </Alert>
          )}

          {connector.grants.length === 0 ? (
            <p className="text-sm text-muted-foreground">Not granted to any key yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {connector.grants.map((g) => (
                <li
                  key={g.id}
                  className="flex items-center justify-between gap-3 rounded-lg bg-surface-muted px-3 py-2"
                >
                  <span className="flex min-w-0 items-center gap-2 text-sm">
                    <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="truncate font-medium">{g.key_name ?? "Untitled key"}</span>
                    {g.key_prefix && (
                      <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                        {g.key_prefix}…
                      </code>
                    )}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => ungrant(g.id)}
                    disabled={busyGrant === g.id}
                    aria-label={`Remove grant for ${g.key_name ?? "key"}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    {busyGrant === g.id ? "Removing…" : "Remove"}
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {/* Grant to a new key */}
          {available.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Label htmlFor={`grant-${connector.id}`} className="sr-only">
                Grant to key
              </Label>
              <select
                id={`grant-${connector.id}`}
                value={selectedKey}
                onChange={(e) => setSelectedKey(e.target.value)}
                className="h-9 flex-1 rounded-lg border border-border bg-surface px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              >
                <option value="">Select a key to grant…</option>
                {available.map((k) => (
                  <option key={k.id} value={k.id}>
                    {(k.name ?? "Untitled key") + (k.key_prefix ? ` (${k.key_prefix}…)` : "")}
                  </option>
                ))}
              </select>
              <Button size="sm" onClick={grant} disabled={!selectedKey || granting}>
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
      </CardContent>
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
      title="Add connector"
      description="Register an external integration. Store secrets by reference, never inline."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? "Creating…" : "Create connector"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 pb-2">
        {error && <Alert tone="danger">{error}</Alert>}

        <div className="space-y-1.5">
          <Label htmlFor="conn-name">Name</Label>
          <Input
            id="conn-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Higgsfield image API"
            autoFocus
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="conn-kind">Kind</Label>
          <select
            id="conn-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}
            className="flex h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="conn-config">Config (JSON)</Label>
          <textarea
            id="conn-config"
            value={config}
            onChange={(e) => setConfig(e.target.value)}
            rows={6}
            spellCheck={false}
            placeholder={placeholder}
            className="flex w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          />
          <p className="text-xs text-muted-foreground">
            {kind === "mcp"
              ? "e.g. server_url and transport for an MCP server."
              : "e.g. base_url and the tools this API exposes."}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="conn-secret">Auth secret reference (optional)</Label>
          <Input
            id="conn-secret"
            value={authRef}
            onChange={(e) => setAuthRef(e.target.value)}
            placeholder="e.g. HIGGSFIELD_API_KEY"
          />
          <p className="text-xs text-muted-foreground">
            The env var or vault key that holds the secret — never the secret itself.
          </p>
        </div>
      </div>
    </Dialog>
  );
}
