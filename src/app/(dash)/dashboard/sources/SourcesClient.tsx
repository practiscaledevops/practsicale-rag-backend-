"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, Database, Plus, RefreshCw } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  Notice,
  Select,
  Table,
  TableCard,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  buttonClass,
} from "@/components/ui";
import { fmtDateTime, humanize, relTime } from "@/lib/format";
import { sourceTypeLabel, statusTone } from "@/lib/ui-labels";

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

export function SourcesClient({ sources }: { sources: DataSource[] }) {
  const router = useRouter();

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

  // Per-row sync state.
  const [syncingId, setSyncingId] = React.useState<string | null>(null);
  const [syncMsg, setSyncMsg] = React.useState<
    { tone: "success" | "danger"; text: string } | null
  >(null);

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

  async function onSync(source: DataSource) {
    setSyncMsg(null);
    setSyncingId(source.id);
    try {
      const res = await fetch(`/api/admin/sources/${source.id}/sync`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.status === "error") {
        setSyncMsg({
          tone: "danger",
          text: `Sync failed for “${source.name}”: ${json.error ?? `HTTP ${res.status}`}`,
        });
        return;
      }
      setSyncMsg({
        tone: "success",
        text:
          `Synced “${source.name}”: ${json.recordsFetched ?? 0} fetched, ` +
          `${json.documentsIngested ?? 0} ingested, ${json.documentsSkipped ?? 0} skipped, ` +
          `${json.chunksIngested ?? 0} chunks.`,
      });
      router.refresh(); // refresh last-run status
    } catch {
      setSyncMsg({ tone: "danger", text: "Network error during sync." });
    } finally {
      setSyncingId(null);
    }
  }

  const newSourceButton = (
    <Button size="toolbar" onClick={openCreate}>
      <Plus size={14} aria-hidden />
      New source
    </Button>
  );

  return (
    <div className="space-y-4">
      {formOk && <Notice message={formOk} onDone={() => setFormOk(null)} />}
      {syncMsg && (
        <Alert tone={syncMsg.tone} onDismiss={() => setSyncMsg(null)}>
          {syncMsg.text}
        </Alert>
      )}

      <TableCard
        title="All sources"
        meta={sources.length > 0 ? `${sources.length} ${sources.length === 1 ? "source" : "sources"}` : undefined}
        actions={sources.length > 0 ? newSourceButton : undefined}
      >
        {sources.length === 0 ? (
          <EmptyState
            variant="plain"
            icon={Database}
            title="No sources yet"
            description="Add a pull endpoint and the Brain will ingest the records it returns."
            action={newSourceButton}
          />
        ) : (
          <Table minWidth={800} caption="Sources">
            <THead>
              <tr>
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
              {sources.map((s) => (
                <Tr key={s.id}>
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
                      <StatusBadge status={s.last_status} />
                      {!s.is_active && <Badge tone="neutral">Paused</Badge>}
                    </div>
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
                        loading={syncingId === s.id}
                        aria-label={`Sync ${s.name}`}
                      >
                        {syncingId !== s.id && <RefreshCw size={14} aria-hidden />}
                        {syncingId === s.id ? "Syncing…" : "Sync"}
                      </Button>
                    </div>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </TableCard>

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
