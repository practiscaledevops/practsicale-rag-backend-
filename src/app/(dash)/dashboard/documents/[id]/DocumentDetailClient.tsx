"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
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
  Hash,
  Database,
  Link2,
  Check,
  Workflow,
} from "lucide-react";
import { Alert, Notice } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card, SectionCard } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Loading";
import { PageHeader } from "@/components/ui/PageHeader";
import { fmtDateTime, fmtInt } from "@/lib/format";
import { sourceTypeLabel, statusTone } from "@/lib/ui-labels";
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

const plural = (n: number, word: string) => `${fmtInt(n)} ${word}${n === 1 ? "" : "s"}`;

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

  // "View chunks" links here with #chunks, but the section only exists once the
  // client fetch lands, so scroll to it on the first successful load.
  const scrolledToHash = React.useRef(false);
  React.useEffect(() => {
    if (!data || scrolledToHash.current) return;
    scrolledToHash.current = true;
    if (window.location.hash === "#chunks") {
      document.getElementById("chunks")?.scrollIntoView({ block: "start" });
    }
  }, [data]);

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

  // A reload of the same document (after a re-ingest) refreshes in place; only
  // the first load, or a different document, shows the loading view.
  if (loading && (!data || data.document.id !== documentId)) {
    return (
      <div>
        <PageHeader title="Document" backHref="/dashboard/documents" backLabel="Documents" />
        <Card className="p-4">
          <Spinner label="Loading document…" className="py-2" />
        </Card>
      </div>
    );
  }

  if (notFound) {
    return (
      <div>
        <PageHeader title="Document not found" backHref="/dashboard/documents" backLabel="Documents" />
        <EmptyState
          icon={FileText}
          title="This document doesn't exist"
          description="It may have been deleted, or it belongs to another workspace."
          action={
            <Link href="/dashboard/documents" className={buttonClass({ variant: "secondary", size: "toolbar" })}>
              Back to documents
            </Link>
          }
        />
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div>
        <PageHeader title="Couldn't load document" backHref="/dashboard/documents" backLabel="Documents" />
        <Alert tone="danger">{loadError ?? "Unknown error."}</Alert>
        <Button variant="secondary" size="toolbar" className="mt-3" onClick={load}>
          <RefreshCw size={14} aria-hidden />
          Try again
        </Button>
      </div>
    );
  }

  const { document: doc, chunks } = data;
  const reingestBlocked = !doc.reingest.available;
  const dialogOpen = renameOpen || deleteOpen;

  return (
    <div>
      <PageHeader
        title={doc.title || "Untitled"}
        description="The full processing view — how this document was redacted, chunked, and embedded."
        backHref="/dashboard/documents"
        backLabel="Documents"
        actions={
          <div className="flex flex-col items-start gap-1 sm:items-end">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="toolbar"
                onClick={() => {
                  setActionError(null);
                  setRenameOpen(true);
                }}
              >
                <Pencil size={14} aria-hidden />
                Edit title
              </Button>

              {/* Re-ingest is disabled when the source text wasn't retained and
                  can't be recovered; the reason shows as text below. */}
              <span title={doc.reingest.reason} className="inline-flex">
                <Button
                  variant="secondary"
                  size="toolbar"
                  disabled={reingestBlocked || busy !== null}
                  loading={busy === "reingesting"}
                  aria-describedby={reingestBlocked ? "reingest-reason" : undefined}
                  onClick={reingest}
                >
                  {busy !== "reingesting" && <RefreshCw size={14} aria-hidden />}
                  {busy === "reingesting" ? "Re-ingesting…" : "Re-ingest"}
                </Button>
              </span>

              <Button
                variant="danger-secondary"
                size="toolbar"
                onClick={() => {
                  setActionError(null);
                  setDeleteOpen(true);
                }}
              >
                <Trash2 size={14} aria-hidden />
                Delete
              </Button>
            </div>
            {reingestBlocked && (
              <p id="reingest-reason" className="max-w-xs text-xs text-muted-foreground sm:text-right">
                {doc.reingest.reason}
              </p>
            )}
          </div>
        }
      />

      {(notice || (actionError && !dialogOpen)) && (
        <div className="mb-4 space-y-2">
          {notice && <Notice message={notice} onDone={() => setNotice(null)} />}
          {actionError && !dialogOpen && (
            <Alert tone="danger" onDismiss={() => setActionError(null)}>
              {actionError}
            </Alert>
          )}
        </div>
      )}

      {/* Header facts */}
      <SectionCard icon={FileText} title="Details" className="mb-4">
        <dl className="grid grid-cols-[112px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px] sm:grid-cols-[140px_minmax(0,1fr)]">
          <Fact label="Type">
            <Badge tone="neutral">{sourceTypeLabel(doc.source_type)}</Badge>
          </Fact>
          <Fact label="Created">{fmtDateTime(doc.created_at)}</Fact>
          <Fact label="Last updated">{fmtDateTime(doc.updated_at)}</Fact>
          <Fact label="Data source">
            {doc.data_source ? (
              <span className="inline-flex items-center gap-1.5">
                <Database size={14} className="shrink-0 text-muted-foreground" aria-hidden />
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
              <span className="inline-flex items-start gap-1.5 break-all">
                <Link2 size={14} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
                {doc.uri}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Fact>
          <Fact label="Content hash">
            {doc.content_hash ? (
              <code className="break-all rounded-md bg-surface-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                {doc.content_hash}
              </code>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Fact>
        </dl>
      </SectionCard>

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
      <ConfirmDialog
        open={deleteOpen}
        tone="danger"
        title="Delete document?"
        description={`“${doc.title || "Untitled"}” and its ${doc.chunk_count} chunk${
          doc.chunk_count === 1 ? "" : "s"
        } will be permanently removed. This cannot be undone.`}
        confirmLabel="Delete"
        busy={busy === "deleting"}
        error={deleteOpen ? actionError : null}
        onConfirm={confirmDelete}
        onCancel={() => {
          if (busy !== "deleting") setDeleteOpen(false);
        }}
      />
    </div>
  );
}

// ---- header fact ---------------------------------------------------------------

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </>
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
      sub: sourceTypeLabel(doc.source_type),
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
    <SectionCard icon={Workflow} title="Processing pipeline" className="mb-4">
      <ol className="flex flex-wrap items-stretch gap-2">
        {steps.map((step, i) => {
          const tone = statusTone(step.done ? "done" : "pending");
          return (
            <React.Fragment key={step.title}>
              <li className="flex min-w-[10rem] flex-1 items-start gap-2.5 rounded-xl border border-border bg-surface p-3">
                <span
                  aria-hidden
                  className={cn(
                    "grid h-8 w-8 shrink-0 place-items-center rounded-full",
                    step.done ? "bg-success/10 text-success" : "bg-surface-muted text-muted-foreground"
                  )}
                >
                  <step.icon size={16} />
                </span>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-foreground">{step.title}</div>
                  <div className="text-xs text-muted-foreground">{step.sub}</div>
                  <Badge tone={tone} className="mt-1.5">
                    {step.done && <Check size={12} aria-hidden />}
                    {step.done ? "Done" : "Pending"}
                  </Badge>
                </div>
              </li>
              {i < steps.length - 1 && (
                <li aria-hidden="true" className="hidden items-center text-muted-foreground sm:flex">
                  <ChevronRight size={16} />
                </li>
              )}
            </React.Fragment>
          );
        })}
      </ol>
    </SectionCard>
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
      <SectionCard id="chunks" icon={Layers} title="Chunks" className="scroll-mt-4">
        <EmptyState
          variant="plain"
          title="No chunks"
          description="This document produced no chunks. Re-ingest it, or re-upload the source file."
          className="py-4"
        />
      </SectionCard>
    );
  }

  return (
    <SectionCard
      id="chunks"
      icon={Layers}
      title="Chunk inspector"
      description={`${plural(doc.chunk_count, "chunk")} · ${fmtInt(doc.embedded_count)} embedded`}
      className="scroll-mt-4"
      bodyClassName="space-y-3"
    >
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
    </SectionCard>
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
  const contentId = React.useId();

  const kind = chunk.is_parent ? "Parent section" : nested ? "Child chunk" : "Chunk";
  const tokens =
    chunk.token_count != null
      ? `${chunk.token_count.toLocaleString()} tokens`
      : chunk.approx_tokens != null
        ? `~${chunk.approx_tokens.toLocaleString()} tokens`
        : null;

  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      {/* Labels row */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-xs font-medium text-muted-foreground">#{index}</span>
        <Badge tone={chunk.is_parent ? "strong" : "neutral"}>{kind}</Badge>

        {chunk.heading && (
          <Badge tone="neutral" className="max-w-[16rem]">
            <Hash size={12} className="shrink-0" aria-hidden />
            <span className="min-w-0 truncate">{chunk.heading.replace(/^#+\s*/, "")}</span>
          </Badge>
        )}

        {chunk.has_embedding ? (
          <Badge tone="success">
            <Check size={12} aria-hidden />
            Embedded · 1024-d
          </Badge>
        ) : (
          <Badge tone="warning">No embedding</Badge>
        )}

        {tokens && <span className="text-xs text-muted-foreground">{tokens}</span>}

        {chunk.collection_ids.length > 0 && (
          <span className="flex flex-wrap gap-1">
            {chunk.collection_ids.map((cid) => (
              <Badge key={cid} tone="neutral">
                {nameFor(cid)}
              </Badge>
            ))}
          </span>
        )}
      </div>

      {/* Content — collapsed to a preview, expandable to a scrollable block */}
      <div
        id={contentId}
        className={cn(
          "whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground",
          open ? "max-h-72 overflow-y-auto rounded-lg bg-surface-muted p-2.5" : "line-clamp-3"
        )}
      >
        {chunk.content}
      </div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={contentId}
        className="mt-1.5 inline-flex items-center gap-1 rounded-md text-xs font-medium text-accent-strong hover:underline"
      >
        {open ? (
          <>
            <ChevronUp size={14} aria-hidden /> Show less
          </>
        ) : (
          <>
            <ChevronDown size={14} aria-hidden /> Show full chunk
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
      size="sm"
      closeOnBackdrop={false}
      dismissible={!saving}
      footer={
        <>
          <Button variant="secondary" size="toolbar" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="toolbar" onClick={() => onSave(value)} loading={saving}>
            {!saving && <Check size={14} aria-hidden />}
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <Field label="Title" error={error}>
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
      </Field>
    </Dialog>
  );
}
