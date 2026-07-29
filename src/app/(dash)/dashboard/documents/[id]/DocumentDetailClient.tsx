"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  FileText,
  ShieldCheck,
  Layers,
  Sparkles,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Pencil,
  Trash2,
  RefreshCw,
  Loader2,
  Hash,
  Database,
  Link2,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { EmptyState } from "@/components/ui/EmptyState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { cn } from "@/lib/utils";

// ---- data shapes (must match the GET /api/admin/documents/[id] response) ------

interface CollectionRef {
  id: string;
  name: string;
}

interface DocumentDetail {
  id: string;
  title: string | null;
  source_type: string;
  uri: string | null;
  content_hash: string | null;
  data_source_id: string | null;
  data_source: { id: string; name: string } | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  chunk_count: number;
  embedded_count: number;
  embedding_dim: number;
  collections: CollectionRef[];
  reingest: { available: boolean; reason: string };
}

interface ChunkDTO {
  id: string;
  content: string;
  token_count: number | null;
  approx_tokens: number | null;
  source_type: string | null;
  is_parent: boolean;
  parent_id: string | null;
  heading: string | null;
  collection_ids: string[];
  has_embedding: boolean;
}

interface DetailResponse {
  document: DocumentDetail;
  chunks: ChunkDTO[];
}

const SOURCE_LABELS: Record<string, string> = {
  document: "Document",
  call_score: "Call score",
  coaching: "Coaching",
  transcript: "Transcript",
};
const sourceLabel = (v: string | null) => (v ? SOURCE_LABELS[v] ?? v : "—");

const fmtDate = (iso: string) => new Date(iso).toLocaleString();

// ---- main component -----------------------------------------------------------

export function DocumentDetailClient({ documentId }: { documentId: string }) {
  const router = useRouter();

  const [data, setData] = React.useState<DetailResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [notFound, setNotFound] = React.useState(false);

  // Action state.
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<null | "saving" | "deleting" | "reingesting">(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setNotFound(false);
    try {
      const res = await fetch(`/api/admin/documents/${encodeURIComponent(documentId)}`);
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(json.error ?? `Could not load document (${res.status})`);
        return;
      }
      setData(json as DetailResponse);
    } catch {
      setLoadError("Network error — please try again.");
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  React.useEffect(() => {
    load();
  }, [load]);

  // ---- actions ----------------------------------------------------------------

  async function saveTitle(nextTitle: string) {
    setBusy("saving");
    setActionError(null);
    try {
      const res = await fetch(`/api/admin/documents/${encodeURIComponent(documentId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: nextTitle }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionError(json.error ?? `Save failed (${res.status})`);
        return;
      }
      setData((prev) =>
        prev ? { ...prev, document: { ...prev.document, title: json.document?.title ?? null } } : prev
      );
      setRenameOpen(false);
      setNotice("Title updated.");
    } catch {
      setActionError("Network error — please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function confirmDelete() {
    setBusy("deleting");
    setActionError(null);
    try {
      const res = await fetch(`/api/admin/documents/${encodeURIComponent(documentId)}`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionError(json.error ?? `Delete failed (${res.status})`);
        setBusy(null);
        return;
      }
      // Gone — return to the list (which re-runs its server component).
      router.push("/dashboard/documents");
    } catch {
      setActionError("Network error — please try again.");
      setBusy(null);
    }
  }

  async function reingest() {
    setBusy("reingesting");
    setActionError(null);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/admin/documents/${encodeURIComponent(documentId)}/reingest`,
        { method: "POST" }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionError(json.error ?? `Re-ingest failed (${res.status})`);
        return;
      }
      setNotice(`Re-ingested — ${json.chunks ?? 0} chunk${json.chunks === 1 ? "" : "s"} rebuilt.`);
      await load(); // same document id; refresh the rebuilt chunks
    } catch {
      setActionError("Network error — please try again.");
    } finally {
      setBusy(null);
    }
  }

  // ---- render states ----------------------------------------------------------

  const backLink = (
    <Link
      href="/dashboard/documents"
      className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      Back to documents
    </Link>
  );

  if (loading) {
    return (
      <div>
        {backLink}
        <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading document…
        </div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div>
        {backLink}
        <EmptyState
          icon={FileText}
          title="Document not found"
          description="It may have been deleted, or it belongs to another workspace."
          action={
            <Link href="/dashboard/documents">
              <Button variant="outline">Back to documents</Button>
            </Link>
          }
        />
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div>
        {backLink}
        <Alert tone="danger" title="Could not load document">
          {loadError ?? "Unknown error."}
        </Alert>
      </div>
    );
  }

  const { document: doc, chunks } = data;

  return (
    <div>
      {backLink}

      {/* Title + primary actions */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight">
            {doc.title || <span className="text-muted-foreground">Untitled</span>}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The full processing view — how this document was redacted, chunked, and embedded.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setActionError(null);
              setRenameOpen(true);
            }}
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
            Edit title
          </Button>

          {/* Re-ingest: disabled (with an explanatory tooltip) when the source
              text wasn't retained and can't be recovered. */}
          <span title={doc.reingest.reason} className="inline-flex">
            <Button
              variant="outline"
              size="sm"
              disabled={!doc.reingest.available || busy !== null}
              onClick={reingest}
            >
              {busy === "reingesting" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
              )}
              {busy === "reingesting" ? "Re-ingesting…" : "Re-ingest"}
            </Button>
          </span>

          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setActionError(null);
              setDeleteOpen(true);
            }}
          >
            <Trash2 className="h-4 w-4 text-danger" aria-hidden="true" />
            Delete
          </Button>
        </div>
      </div>

      {(notice || actionError) && (
        <div className="mb-4 space-y-2">
          {notice && (
            <Alert tone="success" title="Done">
              {notice}
            </Alert>
          )}
          {actionError && <Alert tone="danger">{actionError}</Alert>}
        </div>
      )}

      {/* Header facts */}
      <Card className="mb-4">
        <CardContent className="grid grid-cols-1 gap-x-8 gap-y-4 p-5 sm:grid-cols-2">
          <Fact label="Type">
            <Badge tone="accent">{sourceLabel(doc.source_type)}</Badge>
          </Fact>
          <Fact label="Created">{fmtDate(doc.created_at)}</Fact>
          <Fact label="Last updated">{fmtDate(doc.updated_at)}</Fact>
          <Fact label="Data source">
            {doc.data_source ? (
              <span className="inline-flex items-center gap-1.5">
                <Database className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                {doc.data_source.name}
              </span>
            ) : (
              <span className="text-muted-foreground">Manual upload</span>
            )}
          </Fact>
          <Fact label="Collections">
            {doc.collections.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {doc.collections.map((c) => (
                  <Badge key={c.id} tone="neutral">
                    {c.name}
                  </Badge>
                ))}
              </div>
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
          </Fact>
          <Fact label="URI">
            {doc.uri ? (
              <span className="inline-flex items-center gap-1.5 break-all">
                <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                {doc.uri}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Fact>
          <Fact label="Content hash" className="sm:col-span-2">
            {doc.content_hash ? (
              <code className="break-all rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                {doc.content_hash}
              </code>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Fact>
        </CardContent>
      </Card>

      {/* Processing pipeline */}
      <PipelineStrip doc={doc} chunks={chunks} />

      {/* Chunk inspector */}
      <ChunkInspector doc={doc} chunks={chunks} />

      {/* Rename dialog */}
      <RenameDialog
        open={renameOpen}
        initial={doc.title ?? ""}
        saving={busy === "saving"}
        error={actionError}
        onClose={() => (busy === "saving" ? undefined : setRenameOpen(false))}
        onSave={saveTitle}
      />

      {/* Delete confirm */}
      <Dialog
        open={deleteOpen}
        onClose={() => (busy === "deleting" ? undefined : setDeleteOpen(false))}
        title="Delete document?"
        description={`“${doc.title || "Untitled"}” and its ${doc.chunk_count} chunk${
          doc.chunk_count === 1 ? "" : "s"
        } will be permanently removed. This cannot be undone.`}
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={busy === "deleting"}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDelete} disabled={busy === "deleting"}>
              {busy === "deleting" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              )}
              {busy === "deleting" ? "Deleting…" : "Delete"}
            </Button>
          </>
        }
      >
        {deleteOpen && actionError && (
          <div className="py-1">
            <Alert tone="danger">{actionError}</Alert>
          </div>
        )}
      </Dialog>
    </div>
  );
}

// ---- header fact ---------------------------------------------------------------

function Fact({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-sm text-foreground">{children}</div>
    </div>
  );
}

// ---- processing pipeline strip -------------------------------------------------

function PipelineStrip({ doc, chunks }: { doc: DocumentDetail; chunks: ChunkDTO[] }) {
  const parents = chunks.filter((c) => c.is_parent).length;
  const children = chunks.filter((c) => c.parent_id && !c.is_parent).length;
  const allEmbedded = doc.chunk_count > 0 && doc.embedded_count === doc.chunk_count;

  const steps = [
    {
      icon: FileText,
      title: "Raw file",
      sub: sourceLabel(doc.source_type),
      done: true,
    },
    {
      icon: ShieldCheck,
      title: "PII-redacted",
      sub: "Identifiers masked",
      done: true,
    },
    {
      icon: Layers,
      title: `Chunked · ${doc.chunk_count}`,
      sub:
        parents > 0
          ? `${parents} parent · ${children} child`
          : `${doc.chunk_count} chunk${doc.chunk_count === 1 ? "" : "s"}`,
      done: doc.chunk_count > 0,
    },
    {
      icon: Sparkles,
      title: `Embedded · ${doc.embedding_dim}-d`,
      sub: `${doc.embedded_count}/${doc.chunk_count} vectors`,
      done: allEmbedded,
    },
  ];

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle>Processing pipeline</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-wrap items-stretch gap-2">
          {steps.map((step, i) => (
            <React.Fragment key={step.title}>
              <li className="flex min-w-[9rem] flex-1 items-start gap-3 rounded-lg border border-border bg-surface-muted/40 p-3">
                <div
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                    step.done ? "bg-success/10 text-success" : "bg-surface-muted text-muted-foreground"
                  )}
                >
                  <step.icon className="h-4 w-4" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1 text-sm font-medium">
                    {step.title}
                    {step.done && <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />}
                  </div>
                  <div className="text-xs text-muted-foreground">{step.sub}</div>
                </div>
              </li>
              {i < steps.length - 1 && (
                <li aria-hidden="true" className="hidden items-center sm:flex">
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </li>
              )}
            </React.Fragment>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

// ---- chunk inspector -----------------------------------------------------------

function ChunkInspector({ doc, chunks }: { doc: DocumentDetail; chunks: ChunkDTO[] }) {
  // uuid -> readable collection name (chunk collection_ids are a subset of the doc's).
  const nameFor = React.useCallback(
    (id: string) => doc.collections.find((c) => c.id === id)?.name ?? `${id.slice(0, 8)}…`,
    [doc.collections]
  );

  // 1-based position of every chunk in returned (created_at) order.
  const indexById = React.useMemo(() => {
    const m = new Map<string, number>();
    chunks.forEach((c, i) => m.set(c.id, i + 1));
    return m;
  }, [chunks]);

  // Group children under their parent; parents + standalone chunks are top-level.
  const childrenByParent = React.useMemo(() => {
    const m: Record<string, ChunkDTO[]> = {};
    for (const c of chunks) {
      if (c.parent_id && !c.is_parent) (m[c.parent_id] ??= []).push(c);
    }
    return m;
  }, [chunks]);

  const topLevel = chunks.filter((c) => c.is_parent || !c.parent_id);

  if (chunks.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Chunks</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={Layers}
            title="No chunks"
            description="This document produced no chunks. Re-ingest it, or re-upload the source file."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle>Chunk inspector</CardTitle>
        <span className="text-xs text-muted-foreground">
          {doc.chunk_count} chunk{doc.chunk_count === 1 ? "" : "s"} · {doc.embedded_count} embedded
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        {topLevel.map((chunk) => {
          const kids = childrenByParent[chunk.id] ?? [];
          return (
            <div key={chunk.id} className="space-y-2">
              <ChunkCard chunk={chunk} index={indexById.get(chunk.id) ?? 0} nameFor={nameFor} />
              {kids.length > 0 && (
                <div className="space-y-2 border-l-2 border-border pl-3 sm:pl-4">
                  {kids.map((kid) => (
                    <ChunkCard
                      key={kid.id}
                      chunk={kid}
                      index={indexById.get(kid.id) ?? 0}
                      nameFor={nameFor}
                      nested
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function ChunkCard({
  chunk,
  index,
  nameFor,
  nested = false,
}: {
  chunk: ChunkDTO;
  index: number;
  nameFor: (id: string) => string;
  nested?: boolean;
}) {
  const [open, setOpen] = React.useState(false);

  const kind = chunk.is_parent ? "Parent section" : nested ? "Child chunk" : "Chunk";
  const tokens =
    chunk.token_count != null
      ? `${chunk.token_count.toLocaleString()} tokens`
      : chunk.approx_tokens != null
        ? `~${chunk.approx_tokens.toLocaleString()} tokens`
        : null;

  return (
    <div
      className={cn(
        "rounded-lg border border-border p-3",
        nested ? "bg-surface" : "bg-surface-muted/30"
      )}
    >
      {/* Labels row */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-xs font-semibold text-muted-foreground">#{index}</span>
        <Badge tone={chunk.is_parent ? "accent" : "neutral"}>{kind}</Badge>

        {chunk.heading && (
          <Badge tone="neutral" className="max-w-[16rem] truncate">
            <Hash className="mr-1 h-3 w-3 shrink-0" aria-hidden="true" />
            {chunk.heading.replace(/^#+\s*/, "")}
          </Badge>
        )}

        {chunk.has_embedding ? (
          <Badge tone="success">
            <Check className="mr-1 h-3 w-3" aria-hidden="true" />
            embedding: 1024-d
          </Badge>
        ) : (
          <Badge tone="warning">No embedding</Badge>
        )}

        {tokens && <span className="text-xs text-muted-foreground">{tokens}</span>}

        {chunk.collection_ids.length > 0 && (
          <span className="flex flex-wrap gap-1">
            {chunk.collection_ids.map((cid) => (
              <Badge key={cid} tone="neutral" className="opacity-80">
                {nameFor(cid)}
              </Badge>
            ))}
          </span>
        )}
      </div>

      {/* Content — collapsed to a preview, expandable to a scrollable block */}
      <div
        className={cn(
          "whitespace-pre-wrap break-words text-sm text-foreground",
          open ? "max-h-72 overflow-y-auto rounded-md bg-surface p-2" : "line-clamp-3"
        )}
      >
        {chunk.content}
      </div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
      >
        {open ? (
          <>
            <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> Show less
          </>
        ) : (
          <>
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> Show full chunk
          </>
        )}
      </button>
    </div>
  );
}

// ---- rename dialog -------------------------------------------------------------

function RenameDialog({
  open,
  initial,
  saving,
  error,
  onClose,
  onSave,
}: {
  open: boolean;
  initial: string;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (title: string) => void;
}) {
  const [value, setValue] = React.useState(initial);

  // Reset the field each time the dialog opens.
  React.useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Edit title"
      description="Rename this document. Leave empty to clear the title."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => onSave(value)} disabled={saving}>
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Check className="h-4 w-4" aria-hidden="true" />
            )}
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-2 py-1">
        <Label htmlFor="doc-title">Title</Label>
        <Input
          id="doc-title"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Untitled"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && !saving) onSave(value);
          }}
        />
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}
