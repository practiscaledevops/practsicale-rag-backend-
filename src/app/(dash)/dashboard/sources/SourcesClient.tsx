"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, Database, Loader2, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { Table, THead, TBody, Tr, Th, Td } from "@/components/ui/Table";

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

const sourceTypeLabel = (v: string) =>
  SOURCE_TYPES.find((s) => s.value === v)?.label ?? v;

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  const tone = status === "success" ? "success" : status === "error" ? "danger" : "neutral";
  return <Badge tone={tone}>{status}</Badge>;
}

const fieldClass =
  "flex h-9 w-full rounded-lg border border-border bg-surface px-3 py-1 text-sm " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
  "focus-visible:ring-offset-1 focus-visible:ring-offset-background";

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
      setFormOk(`Created data source “${json.source?.name ?? name}”.`);
      resetForm();
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

  return (
    <div className="space-y-6">
      {/* Create a pull data source */}
      <Card>
        <CardHeader>
          <CardTitle>New pull data source</CardTitle>
          <CardDescription>
            The Brain will call this GET/POST endpoint and ingest the records it returns.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreate} className="space-y-4">
            {formError && <Alert tone="danger">{formError}</Alert>}
            {formOk && <Alert tone="success">{formOk}</Alert>}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ds-name">Name</Label>
                <Input
                  id="ds-name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Call scoring API"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ds-type">Source type</Label>
                <select
                  id="ds-type"
                  className={fieldClass}
                  value={sourceType}
                  onChange={(e) => setSourceType(e.target.value)}
                >
                  {SOURCE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="ds-url">Endpoint URL</Label>
                <Input
                  id="ds-url"
                  type="url"
                  required
                  value={endpointUrl}
                  onChange={(e) => setEndpointUrl(e.target.value)}
                  placeholder="https://scoring.internal/api/records"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ds-method">Method</Label>
                <select
                  id="ds-method"
                  className={fieldClass}
                  value={httpMethod}
                  onChange={(e) => setHttpMethod(e.target.value)}
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ds-auth">Auth type</Label>
                <select
                  id="ds-auth"
                  className={fieldClass}
                  value={authType}
                  onChange={(e) => setAuthType(e.target.value)}
                >
                  {AUTH_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>

              {authType !== "none" && (
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="ds-secret">Auth secret reference</Label>
                  <Input
                    id="ds-secret"
                    value={authSecretRef}
                    onChange={(e) => setAuthSecretRef(e.target.value)}
                    placeholder="SCORING_API_TOKEN"
                    aria-describedby="ds-secret-help"
                  />
                  <p id="ds-secret-help" className="text-xs text-muted-foreground">
                    Enter the <strong>name of a server environment variable</strong> that
                    holds the secret — never the secret itself. The value is read
                    server-side at sync time.
                  </p>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="ds-records">Records path</Label>
                <Input
                  id="ds-records"
                  value={recordsPath}
                  onChange={(e) => setRecordsPath(e.target.value)}
                  placeholder="data.records"
                  aria-describedby="ds-records-help"
                />
                <p id="ds-records-help" className="text-xs text-muted-foreground">
                  Dot path to the array in the response. Leave blank if the response is
                  the array (or a single object).
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ds-cursor">Cursor field</Label>
                <Input
                  id="ds-cursor"
                  value={cursorField}
                  onChange={(e) => setCursorField(e.target.value)}
                  placeholder="updated_at"
                  aria-describedby="ds-cursor-help"
                />
                <p id="ds-cursor-help" className="text-xs text-muted-foreground">
                  Field used as the incremental watermark (optional).
                </p>
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="ds-cron">Schedule (cron)</Label>
                <Input
                  id="ds-cron"
                  value={scheduleCron}
                  onChange={(e) => setScheduleCron(e.target.value)}
                  placeholder="0 * * * *"
                  aria-describedby="ds-cron-help"
                />
                <p id="ds-cron-help" className="text-xs text-muted-foreground">
                  Optional. Stored for scheduled syncs; you can also trigger a sync
                  manually below.
                </p>
              </div>
            </div>

            <div className="flex justify-end">
              <Button type="submit" disabled={creating}>
                {creating ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Plus className="h-4 w-4" aria-hidden="true" />
                )}
                {creating ? "Creating…" : "Create data source"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Existing sources */}
      <Card>
        <CardHeader>
          <CardTitle>Data sources</CardTitle>
          <CardDescription>Registered pull endpoints for your org.</CardDescription>
        </CardHeader>
        <CardContent>
          {syncMsg && (
            <div className="mb-4">
              <Alert tone={syncMsg.tone}>{syncMsg.text}</Alert>
            </div>
          )}

          {sources.length === 0 ? (
            <EmptyState
              icon={Database}
              title="No data sources yet"
              description="Register a pull endpoint above to start ingesting records automatically."
            />
          ) : (
            <Table>
              <THead>
                <Tr>
                  <Th>Name</Th>
                  <Th>Type</Th>
                  <Th>Endpoint</Th>
                  <Th>Auth</Th>
                  <Th>Last status</Th>
                  <Th>Last run</Th>
                  <Th className="text-right">Actions</Th>
                </Tr>
              </THead>
              <TBody>
                {sources.map((s) => (
                  <Tr key={s.id}>
                    <Td className="font-medium">
                      <Link href={`/dashboard/sources/${s.id}`} className="text-accent hover:underline">
                        {s.name}
                      </Link>
                    </Td>
                    <Td>
                      <Badge tone="accent">{sourceTypeLabel(s.source_type)}</Badge>
                    </Td>
                    <Td className="max-w-[22ch] truncate text-muted-foreground" title={s.endpoint_url ?? ""}>
                      {s.http_method ?? "GET"} {s.endpoint_url ?? "—"}
                    </Td>
                    <Td className="text-muted-foreground">{s.auth_type ?? "none"}</Td>
                    <Td>
                      <StatusBadge status={s.last_status} />
                    </Td>
                    <Td className="text-muted-foreground">
                      {s.last_run_at ? new Date(s.last_run_at).toLocaleString() : "Never"}
                    </Td>
                    <Td className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Link
                          href={`/dashboard/sources/${s.id}`}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground"
                        >
                          <Activity className="h-4 w-4" aria-hidden="true" />
                          Health
                        </Link>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onSync(s)}
                          disabled={syncingId === s.id}
                          aria-label={`Sync ${s.name} now`}
                        >
                          {syncingId === s.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          ) : (
                            <RefreshCw className="h-4 w-4" aria-hidden="true" />
                          )}
                          {syncingId === s.id ? "Syncing…" : "Sync now"}
                        </Button>
                      </div>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
