"use client";

// Connectors — register external integrations (MCP servers or third-party HTTP
// APIs) and grant them to specific scoped keys (one or several at a time; grants
// can be selected across connectors and removed in bulk).
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
  BulkActionBar,
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  InlineError,
  Input,
  PageHeader,
  RowCheckbox,
  Select,
  SelectAllCheckbox,
  Skeleton,
  Textarea,
  SELECTED_ROW_CLASS,
  useBulkRun,
  useConfirm,
  usePendingIds,
  useSelection,
  type RowSelection,
} from "@/components/ui";
import { HttpError, bulkErrorMessage, requestJson, runChunks, type BulkFailure } from "@/lib/bulk";
import { fmtDate, fmtInt } from "@/lib/format";
import { statusTone } from "@/lib/ui-labels";
import { cn } from "@/lib/utils";

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
// Helpers
// ---------------------------------------------------------------------------

interface ConnectorsResponse {
  connectors?: Connector[];
  apiKeys?: ApiKeyRef[];
}

interface GrantManyResponse {
  granted?: string[];
  grants?: { id: string; connector_id: string; api_key_id: string }[];
  failed?: BulkFailure[];
}

interface RemoveManyResponse {
  removed?: string[];
  failed?: BulkFailure[];
}

const keyLabel = (name: string | null) => name ?? "Untitled key";

/** `record` without `ids` (returns the same object when nothing changes). */
function omitIds(record: Record<string, string>, ids: readonly string[]): Record<string, string> {
  if (!ids.some((id) => id in record)) return record;
  const next = { ...record };
  for (const id of ids) delete next[id];
  return next;
}

/** Up to six lines for a confirm dialog, then "+N more". */
function NameList({ names }: { names: string[] }) {
  const shown = names.slice(0, 6);
  const rest = names.length - shown.length;
  return (
    <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[13px] text-foreground">
      {shown.map((n, i) => (
        <li key={i} className="break-words">
          {n}
        </li>
      ))}
      {rest > 0 && <li className="list-none text-muted-foreground">+{fmtInt(rest)} more</li>}
    </ul>
  );
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
  /** The connector whose "Grant access" dialog is open. */
  const [grantFor, setGrantFor] = React.useState<string | null>(null);
  /** A failed removal, shown on its own grant row (grant id → message). */
  const [grantErrors, setGrantErrors] = React.useState<Record<string, string>>({});
  /** Grants whose error came from a bulk run: shown, not announced (the bar announces the run). */
  const [quietGrantErrors, setQuietGrantErrors] = React.useState<ReadonlySet<string>>(() => new Set());
  const { confirm, dialog } = useConfirm();
  const newConnectorRef = React.useRef<HTMLButtonElement>(null);

  // Per-grant busy state and one bulk run: removing one grant never disables the others.
  const pending = usePendingIds();
  const bulk = useBulkRun();

  /** `silent` refreshes in the background: no skeleton, and a failure keeps the cards on screen. */
  const load = React.useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const data = await requestJson<ConnectorsResponse>("/api/admin/connectors");
      setConnectors(data?.connectors ?? []);
      setApiKeys(data?.apiKeys ?? []);
      if (silent) setLoadError(null);
    } catch (e) {
      if (!silent) setLoadError(bulkErrorMessage(e, "Failed to load connectors"));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Merge granted links into local state without a full reload.
  const addGrants = React.useCallback((connectorId: string, grants: Grant[]) => {
    if (grants.length === 0) return;
    setConnectors((prev) =>
      prev.map((c) => {
        if (c.id !== connectorId) return c;
        const have = new Set(c.grants.map((g) => g.api_key_id));
        const fresh = grants.filter((g) => !have.has(g.api_key_id));
        return fresh.length ? { ...c, grants: [...c.grants, ...fresh] } : c;
      })
    );
  }, []);
  const dropGrants = React.useCallback((grantIds: readonly string[]) => {
    if (grantIds.length === 0) return;
    const gone = new Set(grantIds);
    setConnectors((prev) =>
      prev.map((c) => (c.grants.some((g) => gone.has(g.id)) ? { ...c, grants: c.grants.filter((g) => !gone.has(g.id)) } : c))
    );
    setGrantErrors((prev) => omitIds(prev, grantIds));
  }, []);

  /** A removed row takes its focused button with it: land on a stable control instead of <body>. */
  const refocusIfLost = React.useCallback(() => {
    window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body) newConnectorRef.current?.focus({ preventScroll: true });
    });
  }, []);

  // Every grant on the page, in display order: the selection spans all cards.
  const grantIds = React.useMemo(() => connectors.flatMap((c) => c.grants.map((g) => g.id)), [connectors]);
  const sel = useSelection(grantIds);

  async function removeGrant(connector: Connector, g: Grant) {
    if (pending.isPending(g.id) || bulk.isActive(g.id)) return;
    const ok = await confirm({
      title: `Remove access for ${keyLabel(g.key_name)}?`,
      description: `Apps using this key can no longer use ${connector.name}. You can grant it again later.`,
      confirmLabel: "Remove access",
      tone: "danger",
    });
    if (!ok) return;
    setGrantErrors((prev) => omitIds(prev, [g.id]));
    setQuietGrantErrors((prev) => {
      if (!prev.has(g.id)) return prev;
      const next = new Set(prev);
      next.delete(g.id);
      return next;
    });
    try {
      await pending.run(g.id, async () => {
        await requestJson(`/api/admin/connectors?grant_id=${encodeURIComponent(g.id)}`, { method: "DELETE" });
        dropGrants([g.id]);
      });
      refocusIfLost();
    } catch (e) {
      setGrantErrors((prev) => ({ ...prev, [g.id]: bulkErrorMessage(e, "Failed to remove grant") }));
      // Removed elsewhere (404): pick up the current state quietly.
      if (e instanceof HttpError && e.status === 404) void load({ silent: true });
    }
  }

  async function removeSelected() {
    const ids = sel.selectedIds;
    if (ids.length === 0 || bulk.running) return;
    const n = ids.length;
    const chosen = new Set(ids);
    const lines = connectors.flatMap((c) =>
      c.grants.filter((g) => chosen.has(g.id)).map((g) => `${keyLabel(g.key_name)} → ${c.name}`)
    );
    const ok = await confirm({
      title: n === 1 ? "Remove 1 grant?" : `Remove ${fmtInt(n)} grants?`,
      description: (
        <>
          Apps using {n === 1 ? "this key" : "these keys"} can no longer use the connector
          {lines.length === 1 ? "" : "s"} listed. You can grant access again later.
          <NameList names={lines} />
        </>
      ),
      confirmLabel: n === 1 ? "Remove access" : `Remove ${fmtInt(n)} grants`,
      tone: "danger",
    });
    if (!ok) return;
    setGrantErrors((prev) => omitIds(prev, ids));
    await bulk.runChunks(
      ids,
      async (batch, signal) => {
        const r = await requestJson<RemoveManyResponse>("/api/admin/connectors", {
          method: "DELETE",
          json: { grant_ids: batch },
          signal,
        });
        const removed = r?.removed ?? [];
        dropGrants(removed);
        return { ok: removed, failed: r?.failed ?? [] };
      },
      {
        verbs: { running: "Removing", done: "removed" },
        missingError: "Grant not found",
        onSettled: (result) => {
          // Failed and cancelled grants stay selected (for Retry failed / Resume); failures show why on their row.
          sel.settle(result);
          if (result.failed.length > 0) {
            setGrantErrors((prev) => ({ ...prev, ...Object.fromEntries(result.failed.map((f) => [f.id, f.error])) }));
            setQuietGrantErrors((prev) => new Set([...prev, ...result.failed.map((f) => f.id)]));
          }
          refocusIfLost();
          void load({ silent: true });
        },
      }
    );
  }

  const grantTarget = grantFor ? connectors.find((c) => c.id === grantFor) ?? null : null;

  return (
    <div className="min-w-0">
      <PageHeader
        title="Connectors"
        description="Outside tools and APIs that API keys can be granted."
        actions={
          <Button ref={newConnectorRef} size="toolbar" onClick={() => setDialogOpen(true)}>
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
              selection={sel}
              isBusy={(grantId) => pending.isPending(grantId) || bulk.isActive(grantId)}
              errors={grantErrors}
              quietErrors={quietGrantErrors}
              onGrant={() => setGrantFor(c.id)}
              onRemove={(g) => void removeGrant(c, g)}
            />
          ))}
        </div>
      )}

      <BulkActionBar
        count={sel.count}
        onClear={sel.clear}
        run={bulk}
        noun={["grant", "grants"]}
        label="Bulk actions for connector grants"
        returnFocus={() => newConnectorRef.current}
        actions={[
          {
            key: "remove",
            label: "Remove access",
            icon: Trash2,
            tone: "danger",
            onClick: () => void removeSelected(),
          },
        ]}
      />

      {grantTarget && (
        <GrantKeysDialog
          connector={grantTarget}
          apiKeys={apiKeys}
          onClose={() => setGrantFor(null)}
          onGranted={(grants) => addGrants(grantTarget.id, grants)}
          onSettled={(failed) => {
            if (failed > 0) void load({ silent: true });
          }}
          returnFocus={() => newConnectorRef.current}
        />
      )}

      {dialogOpen && (
        <CreateConnectorDialog
          onClose={() => setDialogOpen(false)}
          onCreated={(connector) => setConnectors((prev) => [connector, ...prev])}
        />
      )}

      {dialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One connector: details + grant management.
// ---------------------------------------------------------------------------

function ConnectorCard({
  connector,
  apiKeys,
  selection,
  isBusy,
  errors,
  quietErrors,
  onGrant,
  onRemove,
}: {
  connector: Connector;
  apiKeys: ApiKeyRef[];
  selection: RowSelection;
  isBusy: (grantId: string) => boolean;
  errors: Record<string, string>;
  /** Errors a bulk run wrote: shown without an assertive announcement each. */
  quietErrors: ReadonlySet<string>;
  onGrant: () => void;
  onRemove: (grant: Grant) => void;
}) {
  // Keys that can still be granted: active and not already linked.
  const grantedIds = new Set(connector.grants.map((g) => g.api_key_id));
  const available = apiKeys.filter((k) => !k.revoked_at && !grantedIds.has(k.id));
  const KindIcon = connector.kind === "http_api" ? Globe : Plug;

  const ids = connector.grants.map((g) => g.id);
  const selectedHere = ids.filter((id) => selection.isSelected(id)).length;
  const allHere = ids.length > 0 && selectedHere === ids.length;

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
          <p className="mt-0.5 break-words text-xs text-muted-foreground">
            Added {fmtDate(connector.created_at)}
            {connector.auth_secret_ref && (
              <>
                {" · secret ref "}
                <code className="break-all rounded-md bg-surface-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
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
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className={cn("flex min-w-0 items-center gap-2", ids.length > 0 && "pl-3")}>
              {ids.length > 0 && (
                <SelectAllCheckbox
                  checked={allHere}
                  indeterminate={selectedHere > 0 && !allHere}
                  onCheckedChange={(on) => selection.select(ids, on)}
                  label={`Select all keys granted ${connector.name}`}
                />
              )}
              <h3 className="text-xs font-medium text-muted-foreground">
                Granted keys
                {ids.length > 0 && <span className="tabular-nums"> · {fmtInt(ids.length)}</span>}
              </h3>
            </div>
            {available.length > 0 && (
              <Button variant="secondary" size="sm" onClick={onGrant}>
                <Plus size={14} aria-hidden />
                Grant access
                <span className="sr-only"> to {connector.name}</span>
              </Button>
            )}
          </div>

          {connector.grants.length === 0 ? (
            <>
              <p className="text-[13px] text-muted-foreground">Not granted to any key yet.</p>
              {available.length === 0 && (
                <p className="mt-1 text-xs text-muted-foreground">Create an API key first to grant this connector.</p>
              )}
            </>
          ) : (
            <ul className="space-y-1.5">
              {connector.grants.map((g) => {
                const busy = isBusy(g.id);
                const selected = selection.isSelected(g.id);
                const error = errors[g.id];
                const name = keyLabel(g.key_name);
                return (
                  <li
                    key={g.id}
                    className={cn(
                      "flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl px-3 py-1.5",
                      selected ? SELECTED_ROW_CLASS : "bg-surface-muted"
                    )}
                  >
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-[13px]">
                      <RowCheckbox
                        {...selection.rowProps(g.id)}
                        label={`Select ${name}${g.key_prefix ? ` (${g.key_prefix}…)` : ""} on ${connector.name}`}
                        disabled={busy}
                      />
                      <KeyRound size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate font-medium text-foreground">{name}</span>
                      {g.key_prefix && (
                        <code className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                          {g.key_prefix}…
                        </code>
                      )}
                    </label>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onRemove(g)}
                      loading={busy}
                      aria-label={`Remove grant for ${name} on ${connector.name}`}
                    >
                      {!busy && <Trash2 size={14} aria-hidden />}
                      {busy ? "Removing…" : "Remove"}
                    </Button>
                    {error && (
                      <InlineError message={`Couldn't remove: ${error}`} live={!quietErrors.has(g.id)} className="basis-full" />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Grant a connector to several keys at once.
// ---------------------------------------------------------------------------

/** Most keys per grant request (the server's limit). */
const GRANT_BATCH = 50;

function GrantKeysDialog({
  connector,
  apiKeys,
  onClose,
  onGranted,
  onSettled,
  returnFocus,
}: {
  connector: Connector;
  apiKeys: ApiKeyRef[];
  onClose: () => void;
  onGranted: (grants: Grant[]) => void;
  /** After a submit, with the number of keys that could not be granted. */
  onSettled: (failed: number) => void;
  returnFocus?: () => HTMLElement | null;
}) {
  // Keys that can still be granted: active and not already linked.
  const grantedIds = new Set(connector.grants.map((g) => g.api_key_id));
  const available = apiKeys.filter((k) => !k.revoked_at && !grantedIds.has(k.id));
  const availableIds = available.map((k) => k.id);

  const [checked, setChecked] = React.useState<Set<string>>(() => new Set());
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  /** Why a key could not be granted (key id → message). */
  const [keyErrors, setKeyErrors] = React.useState<Record<string, string>>({});

  // Only keys still on the list count (granted ones drop off after a partial submit).
  const chosen = availableIds.filter((id) => checked.has(id));
  const all = availableIds.length > 0 && chosen.length === availableIds.length;

  function toggle(id: string, on: boolean) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function submit() {
    if (chosen.length === 0) {
      setError("Select at least one key");
      return;
    }
    const byId = new Map(apiKeys.map((k) => [k.id, k]));
    setSubmitting(true);
    setError(null);
    setKeyErrors({});
    const result = await runChunks(
      chosen,
      async (batch) => {
        const r = await requestJson<GrantManyResponse>("/api/admin/connectors", {
          method: "POST",
          json: { action: "grant", connector_id: connector.id, api_key_ids: batch },
        });
        onGranted(
          (r?.grants ?? []).map((g) => {
            const key = byId.get(g.api_key_id);
            return {
              id: g.id,
              api_key_id: g.api_key_id,
              key_name: key?.name ?? null,
              key_prefix: key?.key_prefix ?? null,
            };
          })
        );
        return { ok: r?.granted ?? [], failed: r?.failed ?? [] };
      },
      { size: GRANT_BATCH, missingError: "Grant failed" }
    );
    setSubmitting(false);
    onSettled(result.failed.length);
    if (result.failed.length === 0) {
      onClose();
      return;
    }
    // Keep the dialog open on the keys that failed, each with its reason.
    setChecked(new Set(result.failed.map((f) => f.id)));
    setKeyErrors(Object.fromEntries(result.failed.map((f) => [f.id, f.error])));
    const n = result.failed.length;
    setError(
      `${result.ok.length > 0 ? `Granted ${fmtInt(result.ok.length)}. ` : ""}${fmtInt(n)} ${
        n === 1 ? "key" : "keys"
      } couldn't be granted.`
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Grant ${connector.name}`}
      description="Apps holding the selected keys will be able to use this connector."
      closeOnBackdrop={false}
      dismissible={!submitting}
      returnFocus={returnFocus}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={submitting} disabled={chosen.length === 0}>
            {submitting
              ? "Granting…"
              : chosen.length > 1
                ? `Grant to ${fmtInt(chosen.length)} keys`
                : "Grant access"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <Alert tone="danger">{error}</Alert>}

        {available.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">Every active key already has access.</p>
        ) : (
          <fieldset className="min-w-0">
            <legend className="sr-only">Keys</legend>
            <label className="flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 text-[13px] font-medium text-foreground hover:bg-surface-muted">
              <SelectAllCheckbox
                checked={all}
                indeterminate={chosen.length > 0 && !all}
                onCheckedChange={(on) => setChecked(on ? new Set(availableIds) : new Set())}
                label="Select all keys"
                disabled={submitting}
              />
              <span>
                All keys <span className="font-normal text-muted-foreground">({fmtInt(available.length)})</span>
              </span>
            </label>
            <div className="mt-0.5 max-h-72 space-y-0.5 overflow-y-auto border-t border-border pt-1">
              {available.map((k) => {
                const keyError = keyErrors[k.id];
                return (
                  <div key={k.id}>
                    <label className="flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 text-[13px] text-foreground transition-colors hover:bg-surface-muted">
                      <Checkbox
                        checked={checked.has(k.id)}
                        onChange={(e) => toggle(k.id, e.target.checked)}
                        disabled={submitting}
                      />
                      <span className="min-w-0 truncate">{keyLabel(k.name)}</span>
                      {k.key_prefix && (
                        <code className="shrink-0 font-mono text-xs text-muted-foreground">{k.key_prefix}…</code>
                      )}
                    </label>
                    {/* From a bulk grant: the dialog's summary announces it, not each row. */}
                    {keyError && <InlineError message={keyError} live={false} className="px-8 pb-1" />}
                  </div>
                );
              })}
            </div>
          </fieldset>
        )}
      </div>
    </Dialog>
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
