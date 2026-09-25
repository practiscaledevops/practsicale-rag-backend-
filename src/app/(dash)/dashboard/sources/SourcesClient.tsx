"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, Database, Loader2, Pause, Play, Plus, RefreshCw } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  BulkActionBar,
  BulkProgress,
  Dialog,
  EmptyState,
  Field,
  Input,
  Notice,
  RowSelectCell,
  Select,
  SelectAllCell,
  SELECTED_ROW_CLASS,
  Table,
  TableCard,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  buttonClass,
  useBulkRun,
  useConfirm,
  usePendingIds,
  useSelection,
} from "@/components/ui";
import {
  BULK_CONCURRENCY,
  bulkErrorMessage,
  requestJson,
  type BulkFailure,
  type BulkVerbs,
} from "@/lib/bulk";
import { fmtDateTime, fmtInt, humanize, relTime } from "@/lib/format";
import { sourceTypeLabel, statusTone } from "@/lib/ui-labels";
import { cn } from "@/lib/utils";

/** One data source, as returned by /api/admin/sources and the sources page. */
export interface DataSource {
  id: string;
  name: string;
  slug: string | null;
  source_type: string;
  kind: string;
  endpoint_url: string | null;
  http_method: string | null;
  auth_type: string | null;
  auth_secret_ref: string | null;
  records_path: string | null;
  cursor_field: string | null;
  cursor_value: string | null;
  schedule_cron: string | null;
  is_active: boolean;
  last_run_at: string | null;
  last_status: string | null;
  created_at: string;
}

const SOURCE_TYPES: { value: string; label: string }[] = [
  { value: "document", label: "Document" },
  { value: "call_score", label: "Call score" },
  { value: "coaching", label: "Coaching" },
  { value: "transcript", label: "Transcript" },
];
const AUTH_TYPES: { value: string; label: string }[] = [
  { value: "none", label: "None" },
  { value: "bearer", label: "Bearer token" },
  { value: "api_key", label: "API key" },
  { value: "basic", label: "Basic" },
];
const HTTP_METHODS: { value: string; label: string }[] = [
  { value: "GET", label: "GET" },
  { value: "POST", label: "POST" },
];

const authLabel = (v: string | null) => AUTH_TYPES.find((a) => a.value === (v ?? "none"))?.label ?? humanize(v);

/** Last-run status in words (the column used to show the raw lowercase value). */
const SYNC_STATUS_LABELS: Record<string, string> = {
  success: "Succeeded",
  error: "Failed",
  running: "Syncing",
};

/** Table links: foreground text, accent on hover. */
const tableLink = "font-medium text-foreground hover:text-accent-strong hover:underline";

// true only after hydration, so locale-dependent strings never mismatch the server HTML.
const noopSubscribe = () => () => {};
function useHydrated() {
  return React.useSyncExternalStore(noopSubscribe, () => true, () => false);
}

/** Relative time ("5m ago") with the exact local date and time in its tooltip. */
function TimeAgo({ iso, never = "Never" }: { iso: string | null; never?: string }) {
  const hydrated = useHydrated();
  if (!iso) return <span className="text-muted-foreground">{never}</span>;
  return (
    <time dateTime={iso} title={hydrated ? fmtDateTime(iso) : undefined} suppressHydrationWarning>
      {relTime(iso, { never, absolute: hydrated })}
    </time>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <Badge tone="neutral">Never synced</Badge>;
  return <Badge tone={statusTone(status)}>{SYNC_STATUS_LABELS[status] ?? humanize(status)}</Badge>;
}

/** What POST /api/admin/sources/[id]/sync returns (the pull runner's result). */
interface SyncResult {
  status?: "success" | "error";
  error?: string;
  recordsFetched?: number;
  documentsIngested?: number;
  documentsSkipped?: number;
  chunksIngested?: number;
}

/** A sync's outcome, shown under the row's status. */
interface RowMsg {
  tone: "success" | "danger";
  text: string;
}

/** Local changes shown before the server list catches up (router.refresh()). */
type RowPatch = Partial<Pick<DataSource, "is_active" | "last_status" | "last_run_at">>;

const NO_PATCHES: Record<string, RowPatch> = {};
const SYNC_VERBS: BulkVerbs = { running: "Syncing", done: "synced" };
const PAUSE_VERBS: BulkVerbs = { running: "Pausing", done: "paused" };
const RESUME_VERBS: BulkVerbs = { running: "Resuming", done: "resumed" };

const syncSummary = (r: SyncResult | null) =>
  `${fmtInt(r?.recordsFetched ?? 0)} fetched · ${fmtInt(r?.documentsIngested ?? 0)} ingested · ` +
  `${fmtInt(r?.documentsSkipped ?? 0)} skipped · ${fmtInt(r?.chunksIngested ?? 0)} chunks`;

/** fetch rejects with a TypeError when the request never reached the server. */
const errorText = (e: unknown, fallback: string) =>
  e instanceof TypeError ? "Network error — please try again." : bulkErrorMessage(e, fallback);

/**
 * router.refresh() once everything this page started has settled, instead of
 * once per item: a batch of syncs re-renders the server list a single time,
 * and nothing on the page waits for that refresh.
 */
function useIdleRefresh() {
  const router = useRouter();
  const busy = React.useRef(0);
  const wanted = React.useRef(false);
  const timer = React.useRef<number | null>(null);

  const flush = React.useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    // Deferred a tick: a bulk pool starts its next item right after one settles.
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (busy.current > 0 || !wanted.current) return;
      wanted.current = false;
      router.refresh();
    }, 0);
  }, [router]);

  React.useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  /** Run `fn` as page work: the refresh waits for it, then happens once. */
  const track = React.useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      busy.current += 1;
      try {
        return await fn();
      } finally {
        busy.current -= 1;
        wanted.current = true;
        flush();
      }
    },
    [flush]
  );

  const request = React.useCallback(() => {
    wanted.current = true;
    flush();
  }, [flush]);

  return React.useMemo(() => ({ track, request }), [track, request]);
}

export function SourcesClient({ sources }: { sources: DataSource[] }) {
  const router = useRouter();
  const idle = useIdleRefresh();
  const { confirm, dialog } = useConfirm();

  // Create-form state.
  const [name, setName] = React.useState("");
  const [sourceType, setSourceType] = React.useState("call_score");
  const [endpointUrl, setEndpointUrl] = React.useState("");
  const [httpMethod, setHttpMethod] = React.useState("GET");
  const [authType, setAuthType] = React.useState("none");
  const [authSecretRef, setAuthSecretRef] = React.useState("");
  const [recordsPath, setRecordsPath] = React.useState("");
  const [cursorField, setCursorField] = React.useState("");
  const [scheduleCron, setScheduleCron] = React.useState("");

  const [creating, setCreating] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [formOk, setFormOk] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);

  // Per-row state: every row syncs on its own; nothing is page-wide.
  const pending = usePendingIds(); // rows whose sync request is in flight
  const syncRun = useBulkRun(); // "Sync N": one at a time, each up to 5 min
  const toggleRun = useBulkRun(); // "Pause / Resume N": one set-based request
  const [rowMsg, setRowMsg] = React.useState<Record<string, RowMsg>>({});
  const [live, setLive] = React.useState(""); // single-sync results, announced

  // Optimistic row changes, dropped as soon as the server list is refreshed.
  const sourcesRef = React.useRef(sources);
  React.useEffect(() => {
    sourcesRef.current = sources;
  }, [sources]);
  const [local, setLocal] = React.useState<{ base: DataSource[]; patches: Record<string, RowPatch> }>(() => ({
    base: sources,
    patches: NO_PATCHES,
  }));
  const patches = local.base === sources ? local.patches : NO_PATCHES;
  const rows = React.useMemo(
    () => sources.map((s) => (patches[s.id] ? { ...s, ...patches[s.id] } : s)),
    [sources, patches]
  );

  const sel = useSelection(rows.map((s) => s.id));

  const patchRows = React.useCallback((ids: readonly string[], p: RowPatch) => {
    if (ids.length === 0) return;
    setLocal((prev) => {
      const base = sourcesRef.current;
      const next = { ...(prev.base === base ? prev.patches : NO_PATCHES) };
      for (const id of ids) next[id] = { ...next[id], ...p };
      return { base, patches: next };
    });
  }, []);

  const setMsg = React.useCallback((id: string, msg: RowMsg | null) => {
    setRowMsg((prev) => {
      if (!msg && !(id in prev)) return prev;
      const next = { ...prev };
      if (msg) next[id] = msg;
      else delete next[id];
      return next;
    });
  }, []);

  function resetForm() {
    setName("");
    setSourceType("call_score");
    setEndpointUrl("");
    setHttpMethod("GET");
    setAuthType("none");
    setAuthSecretRef("");
    setRecordsPath("");
    setCursorField("");
    setScheduleCron("");
  }

  function openCreate() {
    setFormError(null);
    setCreateOpen(true);
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormOk(null);
    setCreating(true);
    try {
      const res = await fetch("/api/admin/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          source_type: sourceType,
          endpoint_url: endpointUrl,
          http_method: httpMethod,
          auth_type: authType,
          auth_secret_ref: authSecretRef,
          records_path: recordsPath,
          cursor_field: cursorField,
          schedule_cron: scheduleCron,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(json.error ?? `Request failed (${res.status})`);
        return;
      }
      setFormOk(`Created source “${json.source?.name ?? name}”.`);
      resetForm();
      setCreateOpen(false);
      router.refresh(); // re-run the server component to show the new row
    } catch {
      setFormError("Network error — please try again.");
    } finally {
      setCreating(false);
    }
  }

  /**
   * Sync one source. The result lands on that row only; the list is refreshed
   * once everything in flight has settled. Throws (with the row's message) on
   * failure so a bulk run counts it.
   */
  const syncOne = React.useCallback(
    (id: string) =>
      idle.track(async (): Promise<RowMsg> => {
        setMsg(id, null);
        let result: SyncResult | null;
        try {
          // No abort signal: the pull keeps running server-side anyway, so let
          // an in-flight sync report its result even after Cancel.
          result = await requestJson<SyncResult | null>(`/api/admin/sources/${encodeURIComponent(id)}/sync`, {
            method: "POST",
          });
          if (result?.status === "error") throw new Error(result.error || "Sync failed");
        } catch (e) {
          const text = errorText(e, "Sync failed");
          setMsg(id, { tone: "danger", text });
          throw new Error(text);
        }
        const msg: RowMsg = { tone: "success", text: syncSummary(result) };
        patchRows([id], { last_status: "success", last_run_at: new Date().toISOString() });
        setMsg(id, msg);
        return msg;
      }),
    [idle, patchRows, setMsg]
  );

  function onSync(source: DataSource) {
    void pending
      .run(source.id, () => syncOne(source.id))
      .then(
        (msg) => msg && setLive(`Synced “${source.name}”: ${msg.text}`),
        (e: unknown) => setLive(`Sync failed for “${source.name}”: ${bulkErrorMessage(e)}`)
      );
  }

  // Bulk: sync the selected sources one at a time (never bundled into one request).
  async function syncSelected() {
    const ids = sel.selectedIds;
    if (ids.length === 0) return;
    if (ids.length > 1) {
      const ok = await confirm({
        title: `Sync ${fmtInt(ids.length)} sources?`,
        description:
          "They sync one at a time, and each can take up to 5 minutes. Keep this page open until they finish; you can cancel between syncs.",
        confirmLabel: `Sync ${fmtInt(ids.length)}`,
      });
      if (!ok) return;
    }
    await syncRun.run(
      ids,
      async (id) => {
        let ran = false;
        await pending.run(id, () => {
          ran = true;
          return syncOne(id);
        });
        if (!ran) throw new Error("Already syncing");
      },
      {
        concurrency: BULK_CONCURRENCY.sync,
        verbs: SYNC_VERBS,
        onSettled: (r) => {
          sel.select(r.ok, false); // failed ones stay selected for another try
          idle.request();
        },
      }
    );
  }

  // Bulk: pause or resume the selected sources in one org-scoped request.
  async function setActiveSelected(active: boolean) {
    const ids = rows.filter((s) => sel.isSelected(s.id) && s.is_active !== active).map((s) => s.id);
    if (ids.length === 0) return;
    if (!active) {
      const ok = await confirm({
        title: ids.length === 1 ? "Pause syncing this source?" : `Pause syncing ${fmtInt(ids.length)} sources?`,
        description:
          "Scheduled syncs stop until you resume them. Knowledge they have already ingested is not removed.",
        confirmLabel: ids.length === 1 ? "Pause" : `Pause ${fmtInt(ids.length)}`,
      });
      if (!ok) return;
    }
    await toggleRun.runChunks(
      ids,
      async (batch, signal) => {
        patchRows(batch, { is_active: active }); // optimistic; failures are put back below
        const r = await requestJson<{ ids?: string[]; failed?: BulkFailure[] } | null>("/api/admin/sources", {
          method: "PATCH",
          json: { ids: batch, is_active: active },
          signal,
        });
        return { ok: r?.ids ?? [], failed: r?.failed ?? [] };
      },
      {
        verbs: active ? RESUME_VERBS : PAUSE_VERBS,
        missingError: "Data source not found",
        onSettled: (r) => {
          patchRows([...r.failed.map((f) => f.id), ...r.skipped], { is_active: !active });
          // Failed and cancelled rows stay selected; rows ticked meanwhile are kept.
          sel.settle(r);
          idle.request();
        },
      }
    );
  }

  const selectedRows = rows.filter((s) => sel.isSelected(s.id));
  const selectedActive = selectedRows.filter((s) => s.is_active).length;
  const selectedPaused = selectedRows.length - selectedActive;

  const newSourceButton = (
    <Button size="toolbar" onClick={openCreate}>
      <Plus size={14} aria-hidden />
      New source
    </Button>
  );

  return (
    <div className="min-w-0 space-y-4">
      <p className="sr-only" role="status" aria-live="polite">
        {live}
      </p>
      {formOk && <Notice message={formOk} onDone={() => setFormOk(null)} />}

      <TableCard
        title="All sources"
        meta={sources.length > 0 ? `${sources.length} ${sources.length === 1 ? "source" : "sources"}` : undefined}
        actions={sources.length > 0 ? newSourceButton : undefined}
      >
        {syncRun.state && (
          <div className="border-b border-border px-4 py-2.5">
            <BulkProgress
              state={syncRun.state}
              onRetry={() => void syncRun.retryFailed()}
              onCancel={syncRun.cancel}
              onDismiss={syncRun.reset}
            />
          </div>
        )}
        {sources.length === 0 ? (
          <EmptyState
            variant="plain"
            icon={Database}
            title="No sources yet"
            description="Add a pull endpoint and the Brain will ingest the records it returns."
            action={newSourceButton}
          />
        ) : (
          // `relative`: keeps the sr-only header label inside the table's own scroller.
          <Table minWidth={840} caption="Sources" wrapperClassName="relative">
            <THead>
              <tr>
                <SelectAllCell {...sel.selectAllProps} label="Select all sources" />
                <Th>Name</Th>
                <Th>Type</Th>
                <Th>Endpoint</Th>
                <Th>Auth</Th>
                <Th>Status</Th>
                <Th>Last sync</Th>
                <Th className="text-right">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </THead>
            <TBody>
              {rows.map((s) => {
                const syncing = pending.isPending(s.id);
                const queued = !syncing && syncRun.isActive(s.id);
                const msg = rowMsg[s.id];
                return (
                  <Tr key={s.id} className={cn(sel.isSelected(s.id) && SELECTED_ROW_CLASS)}>
                    <RowSelectCell {...sel.rowProps(s.id)} label={`Select ${s.name}`} />
                    <Td>
                      <Link href={`/dashboard/sources/${s.id}`} className={tableLink}>
                        {s.name}
                      </Link>
                    </Td>
                    <Td>
                      <Badge tone="neutral">{sourceTypeLabel(s.source_type)}</Badge>
                    </Td>
                    <Td className="max-w-[22ch] truncate text-muted-foreground" title={s.endpoint_url ?? ""}>
                      <span className="font-mono text-xs">{s.http_method ?? "GET"}</span> {s.endpoint_url ?? "—"}
                    </Td>
                    <Td className="whitespace-nowrap text-muted-foreground">{authLabel(s.auth_type)}</Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-1">
                        {syncing ? (
                          <Badge tone="accent">
                            <Loader2 size={12} className="animate-spin" aria-hidden />
                            Syncing
                          </Badge>
                        ) : queued ? (
                          <Badge tone="neutral">Queued</Badge>
                        ) : (
                          <StatusBadge status={s.last_status} />
                        )}
                        {!s.is_active && <Badge tone="neutral">Paused</Badge>}
                      </div>
                      {msg && !syncing && (
                        <p
                          className={cn(
                            "mt-1 max-w-[40ch] break-words text-xs",
                            msg.tone === "danger" ? "text-danger-ink" : "text-muted-foreground"
                          )}
                        >
                          {msg.text}
                        </p>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-muted-foreground">
                      <TimeAgo iso={s.last_run_at} />
                    </Td>
                    <Td className="py-1 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Link
                          href={`/dashboard/sources/${s.id}`}
                          aria-label={`${s.name} health`}
                          className={buttonClass({ variant: "secondary", size: "toolbar" })}
                        >
                          <Activity size={14} aria-hidden />
                          Health
                        </Link>
                        <Button
                          variant="secondary"
                          size="toolbar"
                          onClick={() => onSync(s)}
                          loading={syncing}
                          disabled={queued}
                          aria-label={`Sync ${s.name}`}
                        >
                          {!syncing && <RefreshCw size={14} aria-hidden />}
                          {syncing ? "Syncing…" : queued ? "Queued" : "Sync"}
                        </Button>
                      </div>
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        )}
      </TableCard>

      <BulkActionBar
        count={sel.count}
        onClear={sel.clear}
        run={toggleRun}
        noun={["source", "sources"]}
        actions={[
          {
            key: "sync",
            label: "Sync",
            icon: RefreshCw,
            tone: "primary",
            onClick: () => void syncSelected(),
            disabled: syncRun.running,
            title: syncRun.running ? "A batch of syncs is already running" : undefined,
          },
          {
            key: "pause",
            label: selectedPaused > 0 ? `Pause ${fmtInt(selectedActive)}` : "Pause",
            icon: Pause,
            onClick: () => void setActiveSelected(false),
            hidden: selectedActive === 0,
            title: selectedPaused > 0 ? "Pauses the selected sources that are active" : undefined,
          },
          {
            key: "resume",
            label: selectedActive > 0 ? `Resume ${fmtInt(selectedPaused)}` : "Resume",
            icon: Play,
            onClick: () => void setActiveSelected(true),
            hidden: selectedPaused === 0,
            title: selectedActive > 0 ? "Resumes the selected sources that are paused" : undefined,
          },
        ]}
      />
      {dialog}

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New source"
        description="The Brain calls this GET or POST endpoint and ingests the records it returns."
        size="lg"
        closeOnBackdrop={false}
        dismissible={!creating}
        footer={
          <>
            <Button variant="secondary" size="toolbar" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button type="submit" form="new-source-form" size="toolbar" loading={creating}>
              {!creating && <Plus size={14} aria-hidden />}
              {creating ? "Creating…" : "Create source"}
            </Button>
          </>
        }
      >
        <form id="new-source-form" onSubmit={onCreate} className="space-y-4">
          {formError && <Alert tone="danger">{formError}</Alert>}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Name" required>
              <Input
                id="ds-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Call scoring API"
              />
            </Field>

            <Field label="Source type">
              <Select
                id="ds-type"
                value={sourceType}
                onChange={(e) => setSourceType(e.target.value)}
                options={SOURCE_TYPES}
              />
            </Field>

            <Field label="Endpoint URL" required className="sm:col-span-2">
              <Input
                id="ds-url"
                type="url"
                required
                value={endpointUrl}
                onChange={(e) => setEndpointUrl(e.target.value)}
                placeholder="https://scoring.internal/api/records"
              />
            </Field>

            <Field label="Method">
              <Select
                id="ds-method"
                value={httpMethod}
                onChange={(e) => setHttpMethod(e.target.value)}
                options={HTTP_METHODS}
              />
            </Field>

            <Field label="Auth type">
              <Select
                id="ds-auth"
                value={authType}
                onChange={(e) => setAuthType(e.target.value)}
                options={AUTH_TYPES}
              />
            </Field>

            {authType !== "none" && (
              <Field
                label="Auth secret reference"
                className="sm:col-span-2"
                hint={
                  <>
                    Enter the <strong className="font-medium text-foreground">name of a server environment variable</strong>{" "}
                    that holds the secret, never the secret itself. The value is read server-side at sync time.
                  </>
                }
              >
                <Input
                  id="ds-secret"
                  value={authSecretRef}
                  onChange={(e) => setAuthSecretRef(e.target.value)}
                  placeholder="SCORING_API_TOKEN"
                />
              </Field>
            )}

            <Field
              label="Records path"
              hint="Dot path to the array in the response. Leave blank if the response is the array (or a single object)."
            >
              <Input
                id="ds-records"
                value={recordsPath}
                onChange={(e) => setRecordsPath(e.target.value)}
                placeholder="data.records"
              />
            </Field>

            <Field label="Cursor field" hint="Field used as the incremental watermark (optional).">
              <Input
                id="ds-cursor"
                value={cursorField}
                onChange={(e) => setCursorField(e.target.value)}
                placeholder="updated_at"
              />
            </Field>

            <Field
              label="Schedule (cron)"
              className="sm:col-span-2"
              hint="Optional. Stored for scheduled syncs; you can also sync manually from the list."
            >
              <Input
                id="ds-cron"
                value={scheduleCron}
                onChange={(e) => setScheduleCron(e.target.value)}
                placeholder="0 * * * *"
              />
            </Field>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
