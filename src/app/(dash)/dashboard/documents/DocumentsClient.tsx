"use client";

import * as React from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Eye,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  Layers,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { Alert, Notice } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import {
  BulkActionBar,
  RowSelectCell,
  SELECTED_ROW_CLASS,
  SelectAllCell,
  useBulkRun,
  usePendingIds,
  useSelection,
  type PendingIds,
} from "@/components/ui/Bulk";
import { Button, buttonClass } from "@/components/ui/Button";
import { ConfirmDialog, useConfirm } from "@/components/ui/ConfirmDialog";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { SearchInput } from "@/components/ui/Input";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { useHydrated } from "@/components/ui/RelTime";
import { Select } from "@/components/ui/Select";
import { FilterTabs } from "@/components/ui/Tabs";
import { Table, TableCard, TableEmptyRow, TBody, Td, Th, THead, Tr } from "@/components/ui/Table";
import {
  BULK_CONCURRENCY,
  HttpError,
  bulkErrorMessage,
  requestJson,
  type BulkFailure,
  type BulkResult,
  type ChunkOutcome,
} from "@/lib/bulk";
import { fmtDate, fmtDateTime, fmtInt } from "@/lib/format";
import { ACCESS_LABELS, sourceTypeLabel, statusTone } from "@/lib/ui-labels";
import { cn } from "@/lib/utils";

/** One document row for the list; enriched with collection/category/access/etc. */
export interface DocumentRow {
  id: string;
  title: string | null;
  source_type: string;
  uri: string | null;
  created_at: string;
  updated_at: string;
  chunk_count: number;
  collection: string | null;
  category: string | null;
  owner: string | null;
  access: string | null;
  review_date: string | null;
  /** The knowledge object this document belongs to (migration 0017), if any. */
  object_id?: string | null;
}

// ---------------------------------------------------------------------------
// Document actions — shared with the collections workspace (KnowledgeWorkspace)
// ---------------------------------------------------------------------------

/** A collection the "Add to / Move to collection" picker can target. */
export interface CollectionOption {
  id: string;
  name: string;
}

/**
 * Documents per bulk-delete request. The endpoint takes 200, but each document
 * cascades to its chunks (embeddings + indexes), so smaller batches keep every
 * statement short.
 */
export const DOCUMENT_DELETE_BATCH = 50;

/** What a 422 from the reingest endpoint means. */
export const NOT_REPROCESSABLE = "Not reprocessable: the original text wasn't kept";

/**
 * Reprocess one document through the single-item endpoint (redact → contextualize
 * → embed, up to ~60s). Bulk runs pool it at BULK_CONCURRENCY.reingest; never
 * bundle several into one request.
 */
export async function reprocessDocument(id: string, signal?: AbortSignal): Promise<void> {
  try {
    await requestJson(`/api/admin/documents/${encodeURIComponent(id)}/reingest`, { method: "POST", signal });
  } catch (e) {
    if (e instanceof HttpError && e.status === 422) throw new HttpError(NOT_REPROCESSABLE, 422, e.body);
    throw e;
  }
}

/**
 * The bulk-reprocess worker: runs each document through `pending`, so a
 * document already busy with a single-row action fails with a reason instead
 * of being rebuilt twice at once (the check reads live state, retries included).
 */
export function reprocessWorker(pending: PendingIds) {
  return async (id: string, signal: AbortSignal): Promise<void> => {
    const ran = await pending.run(id, async () => {
      await reprocessDocument(id, signal);
      return true;
    });
    if (!ran) throw new Error("Already being processed");
  };
}

/** Delete one document (the single `?id=` form). */
export async function deleteDocument(id: string): Promise<void> {
  await requestJson(`/api/admin/documents?id=${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Delete up to 200 documents in one request; chunks and memberships cascade. */
export async function deleteDocuments(ids: string[], signal?: AbortSignal): Promise<ChunkOutcome<string>> {
  const r = await requestJson<{ ids?: string[]; failed?: BulkFailure<string>[] } | null>("/api/admin/documents", {
    method: "DELETE",
    json: { ids },
    signal,
  });
  return { ok: r?.ids ?? [], failed: r?.failed ?? [] };
}

/**
 * A membership change against one collection: add documents to it, move them
 * into it (out of `from`, or out of every other collection when `from` is
 * null), or remove them from it.
 */
export type MembershipChange = { kind: "add" } | { kind: "move"; from: string | null } | { kind: "remove" };

/** Apply a membership change to up to 200 documents in one request. */
export async function changeMembership(
  collectionId: string,
  ids: string[],
  change: MembershipChange,
  signal?: AbortSignal
): Promise<ChunkOutcome<string>> {
  const body =
    change.kind === "move"
      ? change.from
        ? { document_ids: ids, from_collection_id: change.from }
        : { document_ids: ids, exclusive: true }
      : { document_ids: ids };
  const r = await requestJson<{ ids?: string[]; failed?: BulkFailure<string>[]; remaining?: string[] } | null>(
    `/api/admin/collections/${encodeURIComponent(collectionId)}/documents`,
    { method: change.kind === "remove" ? "DELETE" : "POST", json: body, signal }
  );
  return { ok: r?.ids ?? [], failed: r?.failed ?? [], remaining: r?.remaining ?? [] };
}

/** A single-row action's error: the server's reason, else a network hint. */
export function actionError(e: unknown): string {
  return e instanceof HttpError ? bulkErrorMessage(e) : "Network error — please try again.";
}

/** Row errors after a bulk run: set for the failures, cleared for the successes. */
export function mergeRowErrors(prev: Record<string, string>, r: BulkResult<string>): Record<string, string> {
  if (r.ok.length === 0 && r.failed.length === 0) return prev;
  const next = { ...prev };
  for (const id of r.ok) delete next[id];
  for (const f of r.failed) next[f.id] = f.error;
  return next;
}

/**
 * router.refresh(), coalesced: a burst of finished actions re-renders the
 * server list once instead of once per item.
 */
export function useRefreshSoon(delayMs = 300): () => void {
  const router = useRouter();
  const timer = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );
  return React.useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      router.refresh();
    }, delayMs);
  }, [router, delayMs]);
}

/** Pick the target collection for a bulk Add / Move. The run itself shows in the bulk bar. */
export function CollectionPickerDialog({
  open,
  mode,
  count,
  collections,
  excludeId = null,
  sourceName = null,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  mode: "add" | "move";
  count: number;
  collections: readonly CollectionOption[];
  /** Not offered as a target (the collection the documents are shown in). */
  excludeId?: string | null;
  /** Move: the collection they leave. Null = the target becomes their only collection. */
  sourceName?: string | null;
  onCancel: () => void;
  onConfirm: (collection: CollectionOption) => void;
}) {
  const [value, setValue] = React.useState("");
  React.useEffect(() => {
    if (open) setValue("");
  }, [open]);

  const options = React.useMemo(
    () => collections.filter((c) => c.id !== excludeId).map((c) => ({ value: c.id, label: c.name })),
    [collections, excludeId]
  );
  const picked = collections.find((c) => c.id === value && c.id !== excludeId) ?? null;
  const one = count === 1;
  const verb = mode === "add" ? "Add" : "Move";
  const Icon = mode === "add" ? FolderPlus : FolderInput;
  const description =
    mode === "add"
      ? `${one ? "It keeps" : "They keep"} any collections ${one ? "it's" : "they're"} already in.`
      : sourceName
        ? `${one ? "It leaves" : "They leave"} “${sourceName}” and ${one ? "keeps" : "keep"} any other collections.`
        : `The chosen collection becomes ${one ? "its" : "their"} only collection.`;

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={`${verb} ${fmtInt(count)} ${one ? "document" : "documents"} to a collection`}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="toolbar" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="toolbar" disabled={!picked} onClick={() => picked && onConfirm(picked)}>
            <Icon size={14} aria-hidden />
            {verb}
          </Button>
        </>
      }
    >
      {options.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          No {excludeId ? "other " : ""}collections yet. Create one with “New collection” on the Collections page
          first.
        </p>
      ) : (
        <Field label="Collection">
          <Select
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Choose a collection…"
            options={options}
          />
        </Field>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Documents list
// ---------------------------------------------------------------------------

const SOURCE_FILTERS = ["all", "document", "call_score", "coaching", "transcript"] as const;
type SourceFilter = (typeof SOURCE_FILTERS)[number];

const NO_IDS: ReadonlySet<string> = new Set();

/** Freshness from the review date (if any) else the last-updated age. Overdue and stale need attention (warning), not danger. */
function freshness(updatedAt: string, reviewDate: string | null): { label: string; tone: BadgeTone } {
  if (reviewDate) {
    const r = new Date(reviewDate).getTime();
    if (!Number.isNaN(r) && r < Date.now()) return { label: "Review due", tone: statusTone("needs_review") };
  }
  const days = Math.floor((Date.now() - new Date(updatedAt).getTime()) / 86_400_000);
  if (Number.isNaN(days)) return { label: "—", tone: "neutral" };
  if (days < 30) return { label: "Fresh", tone: "success" };
  if (days < 90) return { label: "Aging", tone: "warning" };
  return { label: "Stale", tone: statusTone("stale") };
}

/** Date text, with the exact local date and time in a tooltip that is set only after hydration. */
function UpdatedDate({ iso }: { iso: string }) {
  const hydrated = useHydrated();
  return <span title={hydrated ? fmtDateTime(iso) : undefined}>{fmtDate(iso)}</span>;
}

function accessLabel(v: string | null, sourceType: string): string {
  if (v) return ACCESS_LABELS[v.toLowerCase()] ?? v;
  return sourceType === "call_score" ? "Restricted" : "Team";
}

const docName = (d: DocumentRow) => d.title || "Untitled";
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

export function DocumentsClient({
  documents,
  collections = [],
  truncated = false,
}: {
  documents: DocumentRow[];
  /** The org's collections, for the bulk Add to / Move to picker. */
  collections?: CollectionOption[];
  /** The server list hit its row cap, so older documents are not shown. */
  truncated?: boolean;
}) {
  const refreshSoon = useRefreshSoon();
  const { confirm, dialog } = useConfirm();
  // Busy state per row (single actions) and one bulk run at a time: acting on
  // a row never disables the rest of the table.
  const pending = usePendingIds();
  const bulk = useBulkRun();
  const [target, setTarget] = React.useState<DocumentRow | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<SourceFilter>("all");
  // Deleted here: hidden at once, without waiting for the server re-render.
  const [removed, setRemoved] = React.useState<ReadonlySet<string>>(NO_IDS);
  // Collection labels changed here, until the refreshed list agrees.
  const [labels, setLabels] = React.useState<Record<string, string>>({});
  const [rowErrors, setRowErrors] = React.useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = React.useState("");
  const [picker, setPicker] = React.useState<"add" | "move" | null>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);

  // Drop label overrides the refreshed server list now agrees with (or whose row is gone).
  React.useEffect(() => {
    setLabels((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      const server = new Map(documents.map((d) => [d.id, d.collection]));
      const next = { ...prev };
      for (const id of keys) if (!server.has(id) || server.get(id) === prev[id]) delete next[id];
      return Object.keys(next).length === keys.length ? prev : next;
    });
  }, [documents]);

  const rows = React.useMemo(() => {
    const relabelled = Object.keys(labels).length > 0;
    if (removed.size === 0 && !relabelled) return documents;
    const out: DocumentRow[] = [];
    for (const d of documents) {
      if (removed.has(d.id)) continue;
      const label = labels[d.id];
      out.push(label !== undefined ? { ...d, collection: label } : d);
    }
    return out;
  }, [documents, removed, labels]);

  // Typing stays responsive on a 1,000-row list: filtering follows a deferred copy.
  const deferredQuery = React.useDeferredValue(query);

  const searched = React.useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((d) =>
      `${d.title ?? ""} ${d.collection ?? ""} ${d.category ?? ""} ${d.owner ?? ""}`.toLowerCase().includes(q)
    );
  }, [rows, deferredQuery]);

  const filtered = React.useMemo(
    () => (filter === "all" ? searched : searched.filter((d) => d.source_type === filter)),
    [searched, filter]
  );

  const filterTabs = React.useMemo(
    () =>
      SOURCE_FILTERS.map((f) => ({
        id: f,
        label: f === "all" ? "All" : sourceTypeLabel(f),
        count: f === "all" ? searched.length : searched.filter((d) => d.source_type === f).length,
      })),
    [searched]
  );

  // Selection covers the rows on screen; search / filter changes prune it.
  const visibleIds = React.useMemo(() => filtered.map((d) => d.id), [filtered]);
  const sel = useSelection(visibleIds);

  const isBusy = (id: string) => pending.isPending(id) || bulk.isActive(id);

  function setRowError(id: string, message: string | null) {
    setRowErrors((prev) => {
      if (message !== null) return { ...prev, [id]: message };
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function removeRows(ids: readonly string[]) {
    if (ids.length === 0) return;
    setRemoved((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }

  async function confirmDelete() {
    if (!target) return;
    const doc = target;
    setDeleting(true);
    setError(null);
    try {
      const ran = await pending.run(doc.id, async () => {
        await deleteDocument(doc.id);
        return true;
      });
      if (!ran) {
        setError("This document is busy. Try again when its current action finishes.");
        return;
      }
      // Close now so the dialog hands focus back to the row's trigger, then move
      // focus off the row that is about to go.
      flushSync(() => setTarget(null));
      searchRef.current?.focus();
      removeRows([doc.id]);
      setRowError(doc.id, null);
      refreshSoon();
    } catch (e) {
      setError(actionError(e));
    } finally {
      setDeleting(false);
    }
  }

  async function reprocess(d: DocumentRow) {
    setRowError(d.id, null);
    setNotice(null);
    try {
      const ran = await pending.run(d.id, async () => {
        await reprocessDocument(d.id);
        return true;
      });
      if (!ran) return;
      setNotice(`Reprocessed “${docName(d)}”.`);
      refreshSoon();
    } catch (e) {
      const message = actionError(e);
      setRowError(d.id, message);
      setAnnouncement(`Couldn't reprocess “${docName(d)}”: ${message}`);
    }
  }

  // ---- bulk actions ----------------------------------------------------------
  async function bulkReprocess() {
    // Captured before the dialog, so the run uses the selection that was confirmed.
    const ids = sel.selectedIds;
    if (ids.length === 0) return;
    if (ids.length > 1) {
      const ok = await confirm({
        title: `Reprocess ${fmtInt(ids.length)} documents?`,
        description:
          "Each is re-chunked and re-embedded, two at a time. Keep this page open until it finishes; you can cancel between documents.",
        confirmLabel: `Reprocess ${fmtInt(ids.length)}`,
      });
      if (!ok) return;
    }
    void bulk.run(ids, reprocessWorker(pending), {
      concurrency: BULK_CONCURRENCY.reingest,
      verbs: { running: "Reprocessing", done: "reprocessed" },
      onSettled: (r) => {
        setRowErrors((prev) => mergeRowErrors(prev, r));
        sel.settle(r);
        if (r.ok.length > 0) refreshSoon();
      },
    });
  }

  async function bulkDelete() {
    const ids = sel.selectedIds;
    if (ids.length === 0) return;
    const chosen = rows.filter((d) => sel.selected.has(d.id));
    const chunks = chosen.reduce((n, d) => n + d.chunk_count, 0);
    const linked = chosen.filter((d) => d.object_id).length;
    const n = ids.length;
    const ok = await confirm({
      title: `Delete ${fmtInt(n)} ${plural(n, "document")}?`,
      description:
        `${n === 1 ? "It" : "They"} will be permanently removed, taking ${fmtInt(chunks)} ${plural(chunks, "chunk")} out of retrieval.` +
        (linked > 0
          ? ` ${fmtInt(linked)} ${linked === 1 ? "belongs" : "belong"} to a knowledge object, which keeps its record but loses ${linked === 1 ? "that document" : "those documents"}.`
          : "") +
        " This cannot be undone.",
      confirmLabel: `Delete ${fmtInt(n)}`,
      tone: "danger",
    });
    if (!ok) return;
    void bulk.runChunks(ids, (batch, signal) => deleteDocuments(batch, signal), {
      size: DOCUMENT_DELETE_BATCH,
      missingError: "Document not found",
      verbs: { running: "Deleting", done: "deleted" },
      onSettled: (r) => {
        removeRows(r.ok);
        setRowErrors((prev) => mergeRowErrors(prev, r));
        sel.settle(r);
        if (r.ok.length > 0) refreshSoon();
      },
    });
  }

  function bulkMembership(mode: "add" | "move", to: CollectionOption) {
    setPicker(null);
    const change: MembershipChange = mode === "add" ? { kind: "add" } : { kind: "move", from: null };
    // The labels on screen now, for rows the run changes.
    const shown = new Map(rows.map((d) => [d.id, d.collection]));
    void bulk.runChunks(sel.selectedIds, (batch, signal) => changeMembership(to.id, batch, change, signal), {
      missingError: "Document not found",
      // "Adding 12 of 40…" → "38 added to “Brand” · 2 failed"
      verbs:
        mode === "add"
          ? { running: "Adding", done: `added to “${to.name}”` }
          : { running: "Moving", done: `moved to “${to.name}”` },
      onSettled: (r) => {
        if (r.ok.length > 0) {
          setLabels((prev) => {
            const next = { ...prev };
            for (const id of r.ok) {
              // Move: the target is now its only collection. Add: it shows the target when it had none.
              if (mode === "move" || !(prev[id] ?? shown.get(id))) next[id] = to.name;
            }
            return next;
          });
          refreshSoon();
        }
        setRowErrors((prev) => mergeRowErrors(prev, r));
        sel.settle(r);
      },
    });
  }

  if (documents.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="No documents yet"
        description="Add knowledge or bulk-upload files, or sync a data source, to populate the Brain."
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Link href="/dashboard/knowledge/add" className={buttonClass({ variant: "primary", size: "toolbar" })}>
              <Plus size={14} aria-hidden />
              Add knowledge
            </Link>
            <Link href="/dashboard/uploads" className={buttonClass({ variant: "secondary", size: "toolbar" })}>
              <Upload size={14} aria-hidden />
              Bulk upload
            </Link>
          </div>
        }
      />
    );
  }

  const menuItems = (d: DocumentRow): MenuItem[] => {
    const busy = isBusy(d.id);
    return [
      { label: "Open", icon: Eye, href: `/dashboard/documents/${d.id}` },
      { label: "View chunks", icon: Layers, href: `/dashboard/documents/${d.id}#chunks` },
      {
        label: "Reprocess",
        icon: RefreshCw,
        disabled: busy,
        onSelect: () => void reprocess(d),
      },
      {
        label: "Delete permanently",
        icon: Trash2,
        danger: true,
        separatorBefore: true,
        disabled: busy,
        onSelect: () => {
          setError(null);
          setTarget(d);
        },
      },
    ];
  };

  const filtersActive = query.trim() !== "" || filter !== "all";
  const noCollections = collections.length === 0;

  return (
    <>
      {/* A failed delete shows inside its dialog; everything else shows here. */}
      {error && !target && (
        <Alert tone="danger" className="mb-3" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}
      {notice && <Notice className="mb-3" message={notice} onDone={() => setNotice(null)} />}
      <span role="status" className="sr-only">
        {announcement}
      </span>

      {/* Toolbar: search + type filter */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          ref={searchRef}
          aria-label="Search documents"
          placeholder="Search by title, collection, category, owner…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          wrapperClassName="w-full sm:w-80"
        />
        <FilterTabs label="Filter by type" value={filter} tabs={filterTabs} onChange={setFilter} />
      </div>

      <TableCard
        className="mt-3"
        footer={
          <span>
            {fmtInt(filtered.length)} of {fmtInt(rows.length)} documents
            {truncated &&
              ` · Showing the first ${fmtInt(documents.length)} — use search or filters to narrow the list.`}
          </span>
        }
      >
        {/* relative: the sr-only labels in the cells position against the table's
            own scroller, so they never widen the page. */}
        <Table minWidth={1000} caption="Documents" wrapperClassName="relative">
          <THead>
            <Tr>
              <SelectAllCell {...sel.selectAllProps} label="Select all shown documents" />
              <Th>Title</Th>
              <Th>Type</Th>
              <Th>Access</Th>
              <Th>Status</Th>
              <Th numeric>Chunks</Th>
              <Th>Freshness</Th>
              <Th>Updated</Th>
              <Th className="w-12">
                <span className="sr-only">Actions</span>
              </Th>
            </Tr>
          </THead>
          <TBody>
            {filtered.map((d) => {
              const fresh = freshness(d.updated_at, d.review_date);
              const indexed = d.chunk_count > 0;
              const restricted =
                d.source_type === "call_score" || (d.access ?? "").toLowerCase().includes("restrict");
              const busy = isBusy(d.id);
              const rowError = rowErrors[d.id];
              return (
                <Tr
                  key={d.id}
                  interactive
                  aria-busy={busy || undefined}
                  className={cn(sel.isSelected(d.id) && SELECTED_ROW_CLASS)}
                >
                  <RowSelectCell {...sel.rowProps(d.id)} label={`Select “${docName(d)}”`} />
                  <Td>
                    <div className="max-w-[26rem]">
                      <Link
                        href={`/dashboard/documents/${d.id}`}
                        title={docName(d)}
                        className="block truncate font-medium text-foreground hover:text-accent-strong hover:underline"
                      >
                        {d.title || <span className="italic text-muted-foreground">Untitled</span>}
                      </Link>
                      {(d.category || d.collection) && (
                        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                          {d.category && (
                            <span className="truncate">
                              <span className="sr-only">Category: </span>
                              {d.category}
                            </span>
                          )}
                          {d.category && d.collection && <span aria-hidden>·</span>}
                          {d.collection && (
                            <span className="inline-flex min-w-0 items-center gap-1">
                              <Folder size={12} aria-hidden className="shrink-0" />
                              <span className="sr-only">Collection: </span>
                              <span className="truncate">{d.collection}</span>
                            </span>
                          )}
                        </div>
                      )}
                      {rowError && (
                        <p className="mt-0.5 truncate text-xs text-danger" title={rowError}>
                          {rowError}
                        </p>
                      )}
                    </div>
                  </Td>
                  <Td>
                    <Badge tone="neutral">{sourceTypeLabel(d.source_type)}</Badge>
                  </Td>
                  <Td>
                    <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
                      {restricted && <Lock size={12} aria-hidden />}
                      {accessLabel(d.access, d.source_type)}
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={statusTone(indexed ? "indexed" : "pending")}>
                      {indexed ? "Indexed" : "Pending"}
                    </Badge>
                  </Td>
                  <Td numeric>{fmtInt(d.chunk_count)}</Td>
                  <Td>
                    {fresh.tone === "warning" ? (
                      <Badge tone={fresh.tone}>{fresh.label}</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">{fresh.label}</span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-muted-foreground">
                    <UpdatedDate iso={d.updated_at} />
                  </Td>
                  <Td className="text-right">
                    <Menu
                      label={`Actions for ${docName(d)}`}
                      items={menuItems(d)}
                      trigger={busy ? <Loader2 size={16} aria-hidden className="animate-spin" /> : undefined}
                    />
                  </Td>
                </Tr>
              );
            })}
            {filtered.length === 0 && (
              <TableEmptyRow colSpan={9}>
                <span className="inline-flex flex-wrap items-center justify-center gap-2">
                  No documents match your search or filter.
                  {filtersActive && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setQuery("");
                        setFilter("all");
                        searchRef.current?.focus();
                      }}
                    >
                      Clear filters
                    </Button>
                  )}
                </span>
              </TableEmptyRow>
            )}
          </TBody>
        </Table>
      </TableCard>

      <BulkActionBar
        count={sel.count}
        onClear={sel.clear}
        run={bulk}
        noun={["document", "documents"]}
        returnFocus={() => searchRef.current}
        actions={[
          {
            key: "reprocess",
            label: "Reprocess",
            icon: RefreshCw,
            onClick: () => void bulkReprocess(),
            title: "Rebuild chunks and embeddings, two documents at a time",
          },
          {
            key: "add",
            label: "Add to collection",
            icon: FolderPlus,
            onClick: () => setPicker("add"),
            disabled: noCollections,
            title: noCollections ? "Create a collection first" : undefined,
          },
          {
            key: "move",
            label: "Move to collection",
            icon: FolderInput,
            onClick: () => setPicker("move"),
            disabled: noCollections,
            title: noCollections ? "Create a collection first" : undefined,
          },
          { key: "delete", label: "Delete", icon: Trash2, tone: "danger", onClick: () => void bulkDelete() },
        ]}
      />

      <CollectionPickerDialog
        open={picker !== null}
        mode={picker ?? "add"}
        count={sel.count}
        collections={collections}
        onCancel={() => setPicker(null)}
        onConfirm={(c) => bulkMembership(picker ?? "add", c)}
      />

      <ConfirmDialog
        open={target !== null}
        tone="danger"
        title="Delete document?"
        description={
          target
            ? `“${docName(target)}” will be permanently removed, taking ${target.chunk_count} chunk${
                target.chunk_count === 1 ? "" : "s"
              } out of retrieval.${
                target.object_id ? " Its knowledge object keeps its record but loses this document." : ""
              } This cannot be undone.`
            : undefined
        }
        confirmLabel="Delete"
        busy={deleting}
        error={target ? error : null}
        onConfirm={confirmDelete}
        onCancel={() => {
          if (!deleting) setTarget(null);
        }}
        returnFocus={() => searchRef.current}
      />
      {dialog}
    </>
  );
}
