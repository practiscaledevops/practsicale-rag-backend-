"use client";

// Knowledge control center — a 3-pane operational workspace:
//   collections (left) → documents (middle) → detail inspector (right).
// Full-bleed: the page itself never scrolls; each pane scrolls independently.
// Below xl only one pane shows at a time, picked with the "Workspace pane"
// switcher (choosing a collection opens Documents, a document opens Details).
// xl, not lg: from lg up the shell's 256px rail is open, so a 1024px window
// leaves 768px here, and 280 + 320 of side panes would squeeze the document
// list to ~170px. At 1280 the list gets ~420px.
// Live counts are derived from the documents + collections passed in; the
// document inspector lazy-loads chunks. Every document is shown with its
// Operating Intelligence lane (class · domain) and, when it backs a compiled
// knowledge object, that object's ref.
// Documents in the middle pane can be selected (checkbox, shift-click range,
// select-all for the shown rows) and acted on together from the bulk bar:
// reprocess (a pool of 2 over the single reingest endpoint), add to / move to /
// remove from a collection and delete (server bulk endpoints, ≤200 per request).
// Every action marks only its own rows busy; the list updates locally and the
// server list is refreshed once per action.

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Folder,
  FolderInput,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  Library,
  FileText,
  Database,
  Lock,
  Plus,
  RefreshCw,
  Trash2,
  Eye,
  Layers,
  FlaskConical,
  Loader2,
  ChevronDown,
  ChevronRight,
  X,
  Pencil,
  Save,
  Info,
} from "lucide-react";
import { WORK_MODES, MODE_LABELS } from "@/lib/prompts";
import { ACCESS_LEVELS } from "@/lib/knowledge-taxonomy";
import { domainLabel, humanize } from "@/lib/intelligence-taxonomy";
import { Alert, Notice } from "@/components/ui/Alert";
import { Badge, StatusDot, Tag } from "@/components/ui/Badge";
import {
  BulkActionBar,
  RowCheckbox,
  SELECTED_ROW_CLASS,
  SelectAllCheckbox,
  useBulkRun,
  usePendingIds,
  useSelection,
  type RowSelectBinding,
} from "@/components/ui/Bulk";
import { Button, buttonClass } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { IconButton } from "@/components/ui/IconButton";
import { Input, SearchInput } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Loading";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { RelTime, useHydrated } from "@/components/ui/RelTime";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented, type SegmentedOption } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { CompactStat } from "@/components/ui/StatTile";
import { Switch } from "@/components/ui/Switch";
import { FilterTabs } from "@/components/ui/Tabs";
import { BULK_CONCURRENCY, type BulkVerbs } from "@/lib/bulk";
import { fmtDate, fmtDateTime, fmtInt, relTime } from "@/lib/format";
import { ACCESS_LABELS, CLASS_LABEL, sourceTypeLabel, statusTone, triggerLabel } from "@/lib/ui-labels";
import { cn } from "@/lib/utils";
// Document actions shared with the Documents page (same endpoints, same copy).
import {
  CollectionPickerDialog,
  DOCUMENT_DELETE_BATCH,
  actionError,
  changeMembership,
  deleteDocument,
  deleteDocuments,
  mergeRowErrors,
  reprocessDocument,
  reprocessWorker,
  useRefreshSoon,
  type CollectionOption,
  type MembershipChange,
} from "@/app/(dash)/dashboard/documents/DocumentsClient";

export interface WsSettings {
  owner?: string;
  access_level?: string;
  allowed_work_modes?: string[];
  review_interval_days?: number | null;
  retention_days?: number | null;
  default_source_type?: string;
  ceo_copilot_eligible?: boolean;
  employee_chat_eligible?: boolean;
  client_facing_eligible?: boolean;
}
export interface WsCollection {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  docCount: number;
  settings?: WsSettings;
}
export interface WsDocument {
  id: string;
  title: string | null;
  sourceType: string;
  uri: string | null;
  createdAt: string;
  updatedAt: string;
  chunkCount: number;
  /** Retrieval lane (migration 0017). NULL = legacy row, treated as Business Reality. */
  intelligenceClass: string | null;
  domain: string | null;
  /** The knowledge object this document is the compiled page (or raw source) of. */
  objectId: string | null;
  objectRef: string | null;
  objectName: string | null;
  /** Legacy upload category, or the Business Reality bucket for compiled objects. */
  category: string | null;
  owner: string | null;
  access: string | null;
  reviewDate: string | null;
  collectionIds: string[];
}

const RESTRICTED = new Set(["restricted", "confidential", "ceo_only"]);
const STALE_DAYS = 90;

function ageDays(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : Math.floor((Date.now() - t) / 86_400_000);
}
function docAccess(d: WsDocument): string {
  if (d.access) return ACCESS_LABELS[d.access.toLowerCase()] ?? d.access;
  return d.sourceType === "call_score" ? "Restricted" : "Team";
}
function docRestricted(d: WsDocument): boolean {
  return RESTRICTED.has((d.access ?? "").toLowerCase()) || d.sourceType === "call_score";
}
function docStatus(d: WsDocument): "ready" | "processing" {
  return d.chunkCount > 0 ? "ready" : "processing";
}
function docReviewDue(d: WsDocument): boolean {
  if (!d.reviewDate) return false;
  const r = new Date(d.reviewDate).getTime();
  return !Number.isNaN(r) && r < Date.now();
}
/** Lane label. A NULL class is a legacy row and reads as Business Reality (as hybrid_search_lane treats it). */
function docClassLabel(d: WsDocument): string {
  const id = d.intelligenceClass ?? "business_reality";
  return CLASS_LABEL[id] ?? humanize(id);
}
/** The compiled page of a knowledge object (raw sources link to their object but are not "compiled"). */
function docCompiled(d: WsDocument): boolean {
  return Boolean(d.objectId) && d.intelligenceClass !== "raw_archive";
}
/** A date-only value ("2026-03-01") reads as that calendar day in every time zone. */
function fmtDay(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? fmtDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : fmtDate(value);
}

const FILTERS = [
  ["all", "All"],
  ["compiled", "Compiled"],
  ["raw", "Raw archive"],
  ["call_score", sourceTypeLabel("call_score")],
  ["document", sourceTypeLabel("document")],
  ["ready", "Ready"],
  ["processing", "Processing"],
  ["review", "Needs review"],
  ["restricted", "Restricted"],
  ["recent", "Updated recently"],
] as const;
type FilterKey = (typeof FILTERS)[number][0];

function passesFilter(d: WsDocument, filter: FilterKey): boolean {
  switch (filter) {
    case "all": return true;
    case "compiled": return docCompiled(d);
    case "raw": return d.intelligenceClass === "raw_archive";
    case "call_score": return d.sourceType === "call_score";
    case "document": return d.sourceType === "document";
    case "ready": return d.chunkCount > 0;
    case "processing": return d.chunkCount === 0;
    case "review": return docReviewDue(d);
    case "restricted": return RESTRICTED.has((d.access ?? "").toLowerCase()) || d.sourceType === "call_score";
    case "recent": return ageDays(d.updatedAt) < 7;
  }
}

/** Folder colour bars cycle through the kit colours, as in the chatbot rail. */
const FOLDER_BARS = ["bg-folder-1", "bg-folder-2", "bg-folder-3", "bg-folder-4", "bg-folder-5"];

type Pane = "collections" | "documents" | "details";
const PANE_OPTIONS: SegmentedOption<Pane>[] = [
  { value: "collections", label: "Collections" },
  { value: "documents", label: "Documents" },
  { value: "details", label: "Details" },
];

// A synthetic id for the "All documents" and "Unfiled" pseudo-collections.
const ALL = "__all__";
const UNFILED = "__unfiled__";

// The inspector's chunk list, for the row menu's "View chunks".
const INSPECTOR_CHUNKS_ID = "ws-inspector-chunks";

type NoticeState = { tone: "success" | "danger"; text: string } | null;

const NO_IDS: ReadonlySet<string> = new Set();

/** A document's collections after a membership change into (or out of) `collectionId`. */
function applyMembership(current: readonly string[], change: MembershipChange, collectionId: string): string[] {
  switch (change.kind) {
    case "add":
      return current.includes(collectionId) ? [...current] : [...current, collectionId];
    case "remove":
      return current.filter((c) => c !== collectionId);
    case "move":
      return change.from
        ? [...current.filter((c) => c !== change.from && c !== collectionId), collectionId]
        : [collectionId];
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

export function KnowledgeWorkspace({
  collections,
  documents,
  governanceEnabled,
  truncated = false,
}: {
  collections: WsCollection[];
  documents: WsDocument[];
  governanceEnabled: boolean;
  /** The server's document list hit its row cap, so older documents are not shown. */
  truncated?: boolean;
}) {
  const router = useRouter();
  const refreshSoon = useRefreshSoon();
  const { confirm, dialog } = useConfirm();
  const hydrated = useHydrated();
  const [selectedCol, setSelectedCol] = React.useState<string>(ALL);
  const [selectedDoc, setSelectedDoc] = React.useState<string | null>(null);
  const [colSearch, setColSearch] = React.useState("");
  const [filter, setFilter] = React.useState<FilterKey>("all");
  const [docSearch, setDocSearch] = React.useState("");
  // Busy state per document (single actions) and one bulk run at a time:
  // acting on a document never disables the others.
  const pending = usePendingIds();
  const bulk = useBulkRun();
  const [notice, setNotice] = React.useState<NoticeState>(null);
  // Deleted here: hidden at once, without waiting for the server re-render.
  const [removed, setRemoved] = React.useState<ReadonlySet<string>>(NO_IDS);
  // Memberships changed here (doc id -> collection ids), until the refreshed list agrees.
  const [membership, setMembership] = React.useState<Record<string, string[]>>({});
  const [rowErrors, setRowErrors] = React.useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = React.useState("");
  const [picker, setPicker] = React.useState<"add" | "move" | null>(null);
  // Which pane shows below xl (all three show from xl up; see the layout note below).
  const [pane, setPane] = React.useState<Pane>("collections");
  const docSearchRef = React.useRef<HTMLInputElement>(null);
  const workspaceRef = React.useRef<HTMLDivElement>(null);

  // Drop membership overrides the refreshed server list now agrees with (or whose document is gone).
  React.useEffect(() => {
    setMembership((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      const server = new Map(documents.map((d) => [d.id, d.collectionIds]));
      const next = { ...prev };
      for (const id of keys) {
        const s = server.get(id);
        if (!s || sameIds(s, prev[id])) delete next[id];
      }
      return Object.keys(next).length === keys.length ? prev : next;
    });
  }, [documents]);

  // The server list with this session's deletes and membership changes applied.
  const docs = React.useMemo(() => {
    const changed = Object.keys(membership).length > 0;
    if (removed.size === 0 && !changed) return documents;
    const out: WsDocument[] = [];
    for (const d of documents) {
      if (removed.has(d.id)) continue;
      const ids = membership[d.id];
      out.push(ids ? { ...d, collectionIds: ids } : d);
    }
    return out;
  }, [documents, removed, membership]);

  // Membership index: collectionId -> docs.
  const byCollection = React.useMemo(() => {
    const m = new Map<string, WsDocument[]>();
    for (const d of docs) {
      if (d.collectionIds.length === 0) {
        const arr = m.get(UNFILED) ?? [];
        arr.push(d);
        m.set(UNFILED, arr);
      }
      for (const cid of d.collectionIds) {
        const arr = m.get(cid) ?? [];
        arr.push(d);
        m.set(cid, arr);
      }
    }
    return m;
  }, [docs]);

  // Enriched collection rows (chunk totals, freshness, health, attention).
  const enriched = React.useMemo(() => {
    return collections.map((c, i) => {
      const docs = byCollection.get(c.id) ?? [];
      const chunks = docs.reduce((n, d) => n + d.chunkCount, 0);
      const lastUpdated = docs.reduce<string | null>((acc, d) => (!acc || d.updatedAt > acc ? d.updatedAt : acc), null);
      const failing = docs.filter((d) => d.chunkCount === 0).length;
      const stale = docs.filter((d) => ageDays(d.updatedAt) >= STALE_DAYS).length;
      const s = c.settings ?? {};
      const restricted = RESTRICTED.has(s.access_level ?? "") || docs.some((d) => RESTRICTED.has((d.access ?? "").toLowerCase()));
      const sourceKind = docs.some((d) => d.sourceType === "call_score")
        ? "API sync"
        : "Manual upload";
      const attention = failing > 0 ? "fail" : stale > 0 ? "stale" : !s.owner ? "owner" : restricted ? "restricted" : null;
      // Colour follows the collection's place in the full list, so it doesn't shift while searching.
      const bar = FOLDER_BARS[i % FOLDER_BARS.length];
      return { c, docs, chunks, lastUpdated, failing, stale, restricted, sourceKind, attention, bar };
    });
  }, [collections, byCollection]);

  const filteredCols = React.useMemo(() => {
    const q = colSearch.trim().toLowerCase();
    if (!q) return enriched;
    return enriched.filter((e) => e.c.name.toLowerCase().includes(q));
  }, [enriched, colSearch]);

  // Documents for the middle pane: the selected collection, then search, then the filter.
  const scopeDocs = React.useMemo(
    () =>
      selectedCol === ALL ? docs : selectedCol === UNFILED ? byCollection.get(UNFILED) ?? [] : byCollection.get(selectedCol) ?? [],
    [selectedCol, docs, byCollection]
  );

  // Typing stays responsive over thousands of rows: filtering follows a deferred copy.
  const deferredDocSearch = React.useDeferredValue(docSearch);
  const searchedDocs = React.useMemo(() => {
    const q = deferredDocSearch.trim().toLowerCase();
    if (!q) return scopeDocs;
    return scopeDocs.filter((d) =>
      `${d.title ?? ""} ${d.objectRef ?? ""} ${d.objectName ?? ""} ${docClassLabel(d)} ${domainLabel(d.domain)} ${d.category ?? ""} ${d.owner ?? ""}`
        .toLowerCase()
        .includes(q)
    );
  }, [scopeDocs, deferredDocSearch]);

  const paneDocs = React.useMemo(() => searchedDocs.filter((d) => passesFilter(d, filter)), [searchedDocs, filter]);

  const filterTabs = React.useMemo(
    () =>
      FILTERS.map(([id, label]) => ({
        id,
        label,
        count: id === "all" ? searchedDocs.length : searchedDocs.filter((d) => passesFilter(d, id)).length,
      })),
    [searchedDocs]
  );

  const selectedCollection = collections.find((c) => c.id === selectedCol) ?? null;
  const selectedDocument = docs.find((d) => d.id === selectedDoc) ?? null;
  // The real collection in scope (not All documents / Unfiled): Move leaves it, Remove acts on it.
  const scopeCollection = selectedCol !== ALL && selectedCol !== UNFILED ? selectedCollection : null;
  const collectionOptions = React.useMemo<CollectionOption[]>(
    () => collections.map((c) => ({ id: c.id, name: c.name })),
    [collections]
  );

  // Selection covers the documents in the middle pane; scope, search and filter changes prune it.
  const paneIds = React.useMemo(() => paneDocs.map((d) => d.id), [paneDocs]);
  const sel = useSelection(paneIds);

  const isBusy = (id: string) => pending.isPending(id) || bulk.isActive(id);

  /**
   * Below xl, switching panes hides the one that held focus, so move focus to
   * the new pane's heading. From xl up all panes stay visible and focus stays
   * put, unless `always` (the inspector's close button, which disappears).
   */
  function focusPane(p: Pane, always = false) {
    requestAnimationFrame(() => {
      if (!always && window.matchMedia("(min-width: 1280px)").matches) return;
      workspaceRef.current?.querySelector<HTMLElement>(`[data-pane="${p}"] h2`)?.focus({ preventScroll: true });
    });
  }

  function pickCollection(id: string) {
    setSelectedCol(id);
    setSelectedDoc(null);
    setFilter("all");
    setDocSearch("");
    sel.clear();
    setPane("documents");
    focusPane("documents");
  }

  function pickDocument(id: string) {
    setSelectedDoc(id);
    setPane("details");
    focusPane("details");
  }

  function setRowError(id: string, message: string | null) {
    setRowErrors((prev) => {
      if (message !== null) return { ...prev, [id]: message };
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function removeDocs(ids: readonly string[]) {
    if (ids.length === 0) return;
    setRemoved((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    const gone = new Set(ids);
    setSelectedDoc((cur) => (cur && gone.has(cur) ? null : cur));
  }

  // ---- single-document actions: only that row is busy ----------------------
  async function reprocess(id: string) {
    const name = docs.find((d) => d.id === id)?.title || "Untitled";
    setRowError(id, null);
    setNotice(null);
    try {
      const ran = await pending.run(id, async () => {
        await reprocessDocument(id);
        return true;
      });
      if (!ran) return;
      setNotice({ tone: "success", text: `Reprocessed “${name}”.` });
      refreshSoon();
    } catch (e) {
      const message = actionError(e);
      setRowError(id, message);
      setAnnouncement(`Couldn't reprocess “${name}”: ${message}`);
    }
  }
  async function del(id: string) {
    const d = docs.find((x) => x.id === id);
    const ok = await confirm({
      title: "Delete this document and its chunks permanently?",
      description: d?.objectId
        ? "Its knowledge object keeps its record but loses this document. This can't be undone."
        : "This can't be undone.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    setRowError(id, null);
    try {
      const ran = await pending.run(id, async () => {
        await deleteDocument(id);
        return true;
      });
      if (!ran) return;
      // The row (and its menu trigger) goes now: keep focus on a stable heading.
      focusPane("documents", true);
      removeDocs([id]);
      refreshSoon();
    } catch (e) {
      const message = actionError(e);
      setRowError(id, message);
      setAnnouncement(`Couldn't delete “${d?.title || "Untitled"}”: ${message}`);
    }
  }

  // ---- bulk actions on the selected documents ------------------------------
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
    const chosen = paneDocs.filter((d) => sel.selected.has(d.id));
    const chunks = chosen.reduce((n, d) => n + d.chunkCount, 0);
    const linked = chosen.filter((d) => d.objectId).length;
    const n = ids.length;
    const ok = await confirm({
      title: `Delete ${fmtInt(n)} ${n === 1 ? "document" : "documents"} and ${n === 1 ? "its" : "their"} chunks permanently?`,
      description:
        `${fmtInt(chunks)} ${chunks === 1 ? "chunk leaves" : "chunks leave"} retrieval.` +
        (linked > 0
          ? ` ${fmtInt(linked)} ${linked === 1 ? "belongs" : "belong"} to a knowledge object, which keeps its record but loses ${linked === 1 ? "that document" : "those documents"}.`
          : "") +
        " This can't be undone.",
      confirmLabel: `Delete ${fmtInt(n)}`,
      tone: "danger",
    });
    if (!ok) return;
    void bulk.runChunks(ids, (batch, signal) => deleteDocuments(batch, signal), {
      size: DOCUMENT_DELETE_BATCH,
      missingError: "Document not found",
      verbs: { running: "Deleting", done: "deleted" },
      onSettled: (r) => {
        removeDocs(r.ok);
        setRowErrors((prev) => mergeRowErrors(prev, r));
        sel.settle(r);
        if (r.ok.length > 0) refreshSoon();
      },
    });
  }

  /** Add / move / remove the selected documents, then mirror the change locally. */
  function bulkMembership(change: MembershipChange, collection: CollectionOption, verbs: BulkVerbs) {
    setPicker(null);
    // Memberships as shown now, for documents the run changes.
    const shown = new Map(docs.map((d) => [d.id, d.collectionIds]));
    void bulk.runChunks(sel.selectedIds, (batch, signal) => changeMembership(collection.id, batch, change, signal), {
      missingError: "Document not found",
      verbs,
      onSettled: (r) => {
        if (r.ok.length > 0) {
          setMembership((prev) => {
            const next = { ...prev };
            for (const id of r.ok) next[id] = applyMembership(prev[id] ?? shown.get(id) ?? [], change, collection.id);
            return next;
          });
          refreshSoon();
        }
        setRowErrors((prev) => mergeRowErrors(prev, r));
        sel.settle(r);
      },
    });
  }

  function pickTarget(mode: "add" | "move", to: CollectionOption) {
    // "Adding 12 of 40…" → "38 added to “Brand” · 2 failed"
    if (mode === "add") bulkMembership({ kind: "add" }, to, { running: "Adding", done: `added to “${to.name}”` });
    else
      bulkMembership({ kind: "move", from: scopeCollection?.id ?? null }, to, {
        running: "Moving",
        done: `moved to “${to.name}”`,
      });
  }

  function bulkRemove() {
    if (!scopeCollection) return;
    bulkMembership({ kind: "remove" }, scopeCollection, {
      running: "Removing",
      done: `removed from “${scopeCollection.name}”`,
    });
  }

  const totalDocs = docs.length;
  const totalChunks = docs.reduce((n, d) => n + d.chunkCount, 0);
  const unfiled = byCollection.get(UNFILED) ?? [];
  const scopeName =
    selectedCol === ALL ? "All documents" : selectedCol === UNFILED ? "Unfiled" : selectedCollection?.name ?? "Documents";
  const docFiltersActive = docSearch.trim() !== "" || filter !== "all";

  return (
    <div ref={workspaceRef} className="flex h-full min-h-0 flex-col text-[13px]">
      {/* ============ Top bar ============ */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 sm:px-6">
        <PageHeader title="Collections" className="mb-0 mr-auto" />
        <NewCollectionButton onCreated={() => router.refresh()} />
        <Segmented label="Workspace pane" value={pane} options={PANE_OPTIONS} onChange={setPane} className="xl:hidden" />
      </div>

      {notice && (
        <div className="shrink-0 border-b border-border px-4 py-2 sm:px-6">
          <Notice
            tone={notice.tone}
            message={notice.text}
            onDone={() => setNotice(null)}
            timeoutMs={notice.tone === "success" ? 4000 : 0}
          />
        </div>
      )}
      <span role="status" className="sr-only">
        {announcement}
      </span>

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)_320px]">
        {/* ============ LEFT: collections ============ */}
        <section
          aria-label="Collections"
          data-pane="collections"
          className={cn("flex min-h-0 min-w-0 flex-col xl:border-r xl:border-border", pane !== "collections" && "hidden xl:flex")}
        >
          <div className="shrink-0 border-b border-border p-3">
            <SearchInput
              aria-label="Search collections"
              placeholder="Search collections"
              value={colSearch}
              onChange={(e) => setColSearch(e.target.value)}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <ul className="space-y-0.5">
              <CollectionRow
                active={selectedCol === ALL}
                onClick={() => pickCollection(ALL)}
                icon={<Database size={16} aria-hidden />}
                name="All documents"
                count={totalDocs}
                detail={`${fmtInt(totalDocs)} docs · ${fmtInt(totalChunks)} chunks`}
              />
              {filteredCols.map((e) => (
                <CollectionRow
                  key={e.c.id}
                  active={selectedCol === e.c.id}
                  onClick={() => pickCollection(e.c.id)}
                  icon={e.restricted ? <Lock size={15} aria-hidden /> : <Folder size={16} aria-hidden />}
                  name={e.c.name}
                  count={e.docs.length}
                  // "updated …" only after hydration: it depends on the clock and time zone.
                  detail={`${fmtInt(e.docs.length)} docs · ${fmtInt(e.chunks)} chunks · ${e.sourceKind}${hydrated ? ` · updated ${relTime(e.lastUpdated, { never: "—" })}` : ""}`}
                  attention={e.attention}
                  bar={e.bar}
                />
              ))}
              {unfiled.length > 0 && (
                <CollectionRow
                  active={selectedCol === UNFILED}
                  onClick={() => pickCollection(UNFILED)}
                  icon={<FolderOpen size={16} aria-hidden />}
                  name="Unfiled"
                  count={unfiled.length}
                  detail={`${fmtInt(unfiled.length)} docs`}
                />
              )}
            </ul>
            {colSearch.trim() !== "" && filteredCols.length === 0 && (
              <p className="px-3 py-4 text-xs text-muted-foreground">No collections match “{colSearch.trim()}”.</p>
            )}
          </div>
        </section>

        {/* ============ MIDDLE: documents ============ */}
        <section
          aria-label="Documents"
          data-pane="documents"
          className={cn("flex min-h-0 min-w-0 flex-col xl:border-r xl:border-border", pane !== "documents" && "hidden xl:flex")}
        >
          <div className="shrink-0 space-y-2 border-b border-border p-3">
            <div className="flex min-w-0 items-center gap-2">
              {/* Lines up with the row checkboxes below. */}
              <SelectAllCheckbox {...sel.selectAllProps} label="Select all shown documents" className="ml-1.5" />
              <h2
                tabIndex={-1}
                className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground outline-none"
                title={scopeName}
              >
                {scopeName}
              </h2>
              <SearchInput
                ref={docSearchRef}
                aria-label="Search documents"
                placeholder="Search documents"
                value={docSearch}
                onChange={(e) => setDocSearch(e.target.value)}
                wrapperClassName="w-44 shrink-0 sm:w-56"
              />
            </div>
            <FilterTabs label="Document filter" value={filter} tabs={filterTabs} onChange={setFilter} />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {paneDocs.length === 0 ? (
              <EmptyState
                variant="plain"
                icon={FileText}
                title={scopeDocs.length === 0 ? "No documents here yet" : "No documents match"}
                description={
                  scopeDocs.length === 0
                    ? "Add knowledge or bulk-upload files into this collection to see them here."
                    : "Try a different search or filter."
                }
                action={
                  scopeDocs.length > 0 && docFiltersActive ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDocSearch("");
                        setFilter("all");
                        docSearchRef.current?.focus();
                      }}
                    >
                      Clear search and filter
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <ul className="space-y-0.5">
                {paneDocs.map((d) => (
                  <DocRow
                    key={d.id}
                    d={d}
                    active={selectedDoc === d.id}
                    selection={sel.rowProps(d.id)}
                    busy={isBusy(d.id)}
                    error={rowErrors[d.id]}
                    onSelect={() => pickDocument(d.id)}
                    onViewChunks={() => {
                      pickDocument(d.id);
                      // After the inspector renders (and, below xl, its pane shows).
                      requestAnimationFrame(() =>
                        requestAnimationFrame(() =>
                          document.getElementById(INSPECTOR_CHUNKS_ID)?.scrollIntoView({ block: "start" })
                        )
                      );
                    }}
                    onReprocess={() => void reprocess(d.id)}
                    onDelete={() => void del(d.id)}
                    onPlayground={() => router.push("/dashboard/playground")}
                  />
                ))}
              </ul>
            )}
            {/* Inside the pane's scroller so it sticks to the bottom of the list. */}
            <BulkActionBar
              count={sel.count}
              onClear={sel.clear}
              run={bulk}
              noun={["document", "documents"]}
              returnFocus={() => docSearchRef.current}
              actions={[
                {
                  key: "reprocess",
                  label: "Reprocess",
                  icon: RefreshCw,
                  onClick: () => void bulkReprocess(),
                  title: "Rebuild chunks and embeddings, two documents at a time",
                },
                { key: "delete", label: "Delete", icon: Trash2, tone: "danger", onClick: () => void bulkDelete() },
              ]}
            >
              {/* One menu for add / move / remove keeps the bar short in this narrow pane. */}
              <Menu
                label="Collection actions for the selected documents"
                align="start"
                width={260}
                disabled={bulk.running}
                triggerClassName={buttonClass({ variant: "secondary", size: "toolbar", className: "w-auto" })}
                trigger={
                  <>
                    <Folder size={14} aria-hidden />
                    Collection
                    <ChevronDown size={14} aria-hidden className="text-muted-foreground" />
                  </>
                }
                items={[
                  {
                    label: collectionOptions.length === 0 ? "Add to collection (create one first)" : "Add to collection…",
                    icon: FolderPlus,
                    onSelect: () => setPicker("add"),
                    disabled: collectionOptions.length === 0,
                  },
                  {
                    label: scopeCollection ? `Move out of “${scopeCollection.name}”…` : "Move to collection…",
                    icon: FolderInput,
                    onSelect: () => setPicker("move"),
                    disabled: collectionOptions.length === 0,
                  },
                  ...(scopeCollection
                    ? [
                        {
                          label: `Remove from “${scopeCollection.name}”`,
                          icon: FolderMinus,
                          onSelect: bulkRemove,
                        } satisfies MenuItem,
                      ]
                    : []),
                ]}
              />
            </BulkActionBar>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <span className="tabular-nums">{fmtInt(paneDocs.length)} shown</span>
            {truncated && (
              <span className="inline-flex items-center gap-1">
                <Info size={12} aria-hidden className="shrink-0" />
                Showing the first {fmtInt(documents.length)} documents
              </span>
            )}
          </div>
        </section>

        {/* ============ RIGHT: detail inspector ============ */}
        <aside
          aria-label="Details"
          data-pane="details"
          className={cn("flex min-h-0 min-w-0 flex-col", pane !== "details" && "hidden xl:flex")}
        >
          {selectedDocument ? (
            <DocumentInspector
              d={selectedDocument}
              busy={isBusy(selectedDocument.id)}
              error={rowErrors[selectedDocument.id]}
              onClose={() => {
                setSelectedDoc(null);
                setPane("documents");
                focusPane("documents", true);
              }}
              onReprocess={() => void reprocess(selectedDocument.id)}
            />
          ) : selectedCol !== ALL && selectedCol !== UNFILED && selectedCollection ? (
            <CollectionInspector
              c={selectedCollection}
              enriched={enriched.find((e) => e.c.id === selectedCollection.id)}
              governanceEnabled={governanceEnabled}
            />
          ) : (
            <EmptyState
              variant="plain"
              icon={Library}
              title="Knowledge inspector"
              description="Select a collection or a document to see its details, chunks, and health."
              className="flex-1 justify-center"
            />
          )}
        </aside>
      </div>

      <CollectionPickerDialog
        open={picker !== null}
        mode={picker ?? "add"}
        count={sel.count}
        collections={collectionOptions}
        excludeId={scopeCollection?.id ?? null}
        sourceName={scopeCollection?.name ?? null}
        onCancel={() => setPicker(null)}
        onConfirm={(c) => pickTarget(picker ?? "add", c)}
      />
      {dialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Left: collection row
// ---------------------------------------------------------------------------
function CollectionRow({
  active,
  onClick,
  icon,
  name,
  count,
  detail,
  attention,
  bar,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  name: string;
  count: number;
  /** Full summary, shown on hover (the inspector shows the same facts). */
  detail: string;
  attention?: string | null;
  /** Folder colour bar class (real collections only). */
  bar?: string;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? "true" : undefined}
        title={detail}
        className={cn(
          "relative flex h-8 w-full items-center gap-2.5 rounded-lg pl-3 pr-2 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          active ? "bg-accent-soft font-medium text-accent-strong" : "text-foreground hover:bg-surface-muted"
        )}
      >
        {/* Hairline ring: the pale folder colours (yellow, tea) vanish on white without it. */}
        {bar && <span aria-hidden className={cn("absolute inset-y-1.5 left-0 w-[3px] rounded-r-full ring-1 ring-foreground/10", bar)} />}
        <span className={cn("flex w-4 shrink-0 items-center justify-center", active ? "text-accent" : "text-muted-foreground")}>
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {attention && <AttentionDot kind={attention} />}
        <span className={cn("shrink-0 text-xs font-normal tabular-nums", active ? "text-accent-strong" : "text-muted-foreground")}>
          {fmtInt(count)}
          <span className="sr-only"> documents</span>
        </span>
      </button>
    </li>
  );
}

const ATTENTION: Record<string, { label: string; dot: string }> = {
  fail: { label: "Has failing documents", dot: "bg-danger" },
  stale: { label: "Stale knowledge", dot: "bg-warning" },
  owner: { label: "No owner", dot: "bg-warning" },
  restricted: { label: "Restricted", dot: "bg-muted-foreground/50" },
};

function AttentionDot({ kind }: { kind: string }) {
  const a = ATTENTION[kind] ?? ATTENTION.restricted;
  return (
    <span title={a.label} className="flex shrink-0 items-center">
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", a.dot)} />
      <span className="sr-only">({a.label})</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Middle: document row (+ actions menu)
// ---------------------------------------------------------------------------
/** The object's stable ref (BR-SAL-003), linking to its page. Muted for a raw source, accent for the compiled page. */
function RefChip({ d }: { d: WsDocument }) {
  if (!d.objectRef || !d.objectId) return null;
  const compiled = docCompiled(d);
  return (
    <Link
      href={`/dashboard/knowledge/${d.objectId}`}
      title={`${compiled ? "Open knowledge object" : "Raw source of"} ${d.objectName ?? d.objectRef}`}
      className={cn(
        "shrink-0 rounded-md border px-1.5 font-mono text-[11px] leading-5 hover:underline",
        compiled ? "border-accent/30 text-accent-strong" : "border-border text-muted-foreground"
      )}
    >
      {d.objectRef}
    </Link>
  );
}

function DocRow({
  d,
  active,
  selection,
  busy,
  error,
  onSelect,
  onViewChunks,
  onReprocess,
  onDelete,
  onPlayground,
}: {
  d: WsDocument;
  active: boolean;
  /** Bulk-selection checkbox binding (sel.rowProps). */
  selection: RowSelectBinding;
  busy: boolean;
  /** The last action on this document failed with this message. */
  error?: string;
  onSelect: () => void;
  onViewChunks: () => void;
  onReprocess: () => void;
  onDelete: () => void;
  onPlayground: () => void;
}) {
  const ready = docStatus(d) === "ready";
  const restricted = docRestricted(d);
  const name = d.title || "Untitled";
  const items: MenuItem[] = [
    { label: "Open details", icon: Eye, onSelect },
    { label: "View chunks", icon: Layers, onSelect: onViewChunks },
    { label: "Test retrieval", icon: FlaskConical, onSelect: onPlayground },
    { label: "Reprocess", icon: RefreshCw, onSelect: onReprocess, disabled: busy },
    { label: "Delete permanently", icon: Trash2, danger: true, separatorBefore: true, onSelect: onDelete, disabled: busy },
  ];

  // The row is a list item holding four siblings (checkbox, select button, ref
  // link, menu), so no control is nested in another and nothing fires twice.
  return (
    <li
      aria-busy={busy || undefined}
      className={cn(
        "flex items-center gap-1 rounded-lg pr-1 transition-colors",
        // The open document keeps an inset bar, so it stays distinct from selected rows.
        active
          ? "bg-accent-soft shadow-[inset_3px_0_0_rgb(var(--accent))]"
          : selection.checked
            ? SELECTED_ROW_CLASS
            : "hover:bg-surface-muted"
      )}
    >
      {/* The label is the hit area; pt lines the box up with the title line. */}
      <label className="flex shrink-0 cursor-pointer items-start self-stretch pl-2.5 pt-2.5">
        <RowCheckbox {...selection} label={`Select “${name}”`} />
      </label>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
        className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg py-2 pl-2 pr-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <FileText
          size={14}
          aria-hidden
          className={cn("mt-[3px] shrink-0", active ? "text-accent" : "text-muted-foreground")}
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[13px] font-medium",
                active ? "text-accent-strong" : "text-foreground"
              )}
            >
              {name}
            </span>
            <Badge tone={statusTone(ready ? "ready" : "processing")} className="shrink-0">
              {ready ? "Ready" : "Processing"}
            </Badge>
          </span>
          <span
            className={cn(
              "mt-0.5 block truncate text-xs",
              active ? "text-foreground/75" : "text-muted-foreground"
            )}
          >
            {docClassLabel(d)}
            {d.domain ? ` · ${domainLabel(d.domain)}` : ""}
            {" · "}
            {restricted && <Lock size={11} aria-hidden className="-mt-px mr-0.5 inline" />}
            {docAccess(d)}
            {` · ${fmtInt(d.chunkCount)} chunk${d.chunkCount === 1 ? "" : "s"} · `}
            {/* Server-rendered row: RelTime keeps the SSR text time-zone independent. */}
            <RelTime iso={d.updatedAt} />
          </span>
          {error && (
            <span className="mt-0.5 block truncate text-xs text-danger" title={error}>
              {error}
            </span>
          )}
        </span>
      </button>
      <RefChip d={d} />
      <Menu
        size="sm"
        label={`Actions for ${name}`}
        items={items}
        trigger={busy ? <Loader2 size={14} aria-hidden className="animate-spin" /> : undefined}
      />
    </li>
  );
}

// ---------------------------------------------------------------------------
// Right: shared inspector bits
// ---------------------------------------------------------------------------
function InspectorSection({ title, id, children }: { title: string; id?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-5 scroll-mt-4">
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** Label/value definition grid (the document detail page's recipe, narrowed for the pane). */
function DefList({ children }: { children: React.ReactNode }) {
  return <dl className="grid grid-cols-[104px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">{children}</dl>;
}
function Def({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </>
  );
}
function Missing() {
  return <span className="text-muted-foreground">Not set</span>;
}

// ---------------------------------------------------------------------------
// Right: collection inspector
// ---------------------------------------------------------------------------
type Enriched = { docs: WsDocument[]; chunks: number; lastUpdated: string | null; failing: number; stale: number; restricted: boolean; sourceKind: string; attention: string | null };

function CollectionInspector({ c, enriched, governanceEnabled }: { c: WsCollection; enriched?: Enriched; governanceEnabled: boolean }) {
  const router = useRouter();
  const s = c.settings ?? {};
  const docs = enriched?.docs ?? [];
  const [editing, setEditing] = React.useState(false);
  React.useEffect(() => setEditing(false), [c.id]);
  const noEligibility = s.ceo_copilot_eligible === false && s.employee_chat_eligible === false && !s.client_facing_eligible;

  return (
    <>
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {enriched?.restricted ? (
              <Lock size={16} aria-hidden className="shrink-0 text-muted-foreground" />
            ) : (
              <Folder size={16} aria-hidden className="shrink-0 text-accent" />
            )}
            <h2 tabIndex={-1} className="truncate text-sm font-semibold text-foreground outline-none" title={c.name}>
              {c.name}
            </h2>
          </div>
          {c.description && <p className="mt-1 text-xs text-muted-foreground">{c.description}</p>}
        </div>
        {governanceEnabled && !editing && (
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            <Pencil size={12} aria-hidden />
            Edit
            <span className="sr-only"> governance for {c.name}</span>
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-2 gap-2">
          <CompactStat label="Documents" value={fmtInt(docs.length)} />
          <CompactStat label="Chunks" value={fmtInt(enriched?.chunks ?? 0)} />
          <CompactStat label="Failing" value={fmtInt(enriched?.failing ?? 0)} />
          <CompactStat label="Stale (90d+)" value={fmtInt(enriched?.stale ?? 0)} />
        </div>

        {editing ? (
          <GovernanceEditor
            id={c.id}
            initial={s}
            onCancel={() => setEditing(false)}
            onSaved={() => { setEditing(false); router.refresh(); }}
          />
        ) : (
          <>
            <InspectorSection title="Governance">
              <DefList>
                <Def label="Owner">{s.owner || <Missing />}</Def>
                <Def label="Access level">{ACCESS_LABELS[s.access_level ?? ""] ?? "Team"}</Def>
                <Def label="Source">{enriched?.sourceKind ?? "—"}</Def>
                <Def label="Last updated">
                  <span title={enriched?.lastUpdated ? fmtDateTime(enriched.lastUpdated) : undefined}>
                    {relTime(enriched?.lastUpdated ?? null, { never: "—" })}
                  </span>
                </Def>
                <Def label="Review cycle">{s.review_interval_days ? `${s.review_interval_days} days` : <Missing />}</Def>
                <Def label="Retention">{s.retention_days ? `${s.retention_days} days` : "Keep"}</Def>
              </DefList>
            </InspectorSection>

            <InspectorSection title="Chatbot eligibility">
              <div className="flex flex-wrap gap-1.5">
                {s.ceo_copilot_eligible !== false && <Badge tone="neutral">CEO Copilot</Badge>}
                {s.employee_chat_eligible !== false && <Badge tone="neutral">Team chat</Badge>}
                {s.client_facing_eligible && <Badge tone="neutral">Client-facing</Badge>}
                {noEligibility && <span className="text-xs text-muted-foreground">None</span>}
              </div>
              {(s.allowed_work_modes?.length ?? 0) > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {s.allowed_work_modes!.map((m) => (
                    <Badge key={m} tone="neutral">
                      {MODE_LABELS[m as keyof typeof MODE_LABELS] ?? m.replace(/_/g, " ")}
                    </Badge>
                  ))}
                </div>
              )}
            </InspectorSection>

            {!governanceEnabled && (
              <Alert tone="info" title="Not enabled yet" className="mt-5">
                <p>Governance settings aren&apos;t available in this workspace yet.</p>
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs font-medium text-foreground">Technical details</summary>
                  <p className="mt-1 text-xs">
                    Apply Brain migration <code className="font-mono">0013_collection_settings.sql</code>.
                  </p>
                </details>
              </Alert>
            )}
          </>
        )}
      </div>
    </>
  );
}

function GovernanceEditor({ id, initial, onCancel, onSaved }: { id: string; initial: WsSettings; onCancel: () => void; onSaved: () => void }) {
  const [owner, setOwner] = React.useState(initial.owner ?? "");
  const [access, setAccess] = React.useState(initial.access_level ?? "team");
  const [review, setReview] = React.useState(initial.review_interval_days?.toString() ?? "");
  const [retention, setRetention] = React.useState(initial.retention_days?.toString() ?? "");
  const [modes, setModes] = React.useState<Set<string>>(() => new Set(initial.allowed_work_modes ?? []));
  const [ceo, setCeo] = React.useState(initial.ceo_copilot_eligible !== false);
  const [team, setTeam] = React.useState(initial.employee_chat_eligible !== false);
  const [client, setClient] = React.useState(initial.client_facing_eligible === true);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  async function save() {
    setBusy(true);
    setErr(null);
    const settings: WsSettings = {
      owner: owner.trim() || undefined,
      access_level: access,
      allowed_work_modes: [...modes],
      review_interval_days: review ? Math.max(0, parseInt(review, 10)) : null,
      retention_days: retention ? Math.max(0, parseInt(retention, 10)) : null,
      ceo_copilot_eligible: ceo,
      employee_chat_eligible: team,
      client_facing_eligible: client,
    };
    try {
      const res = await fetch(`/api/admin/collections/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(j.error ?? "Save failed");
        return;
      }
      onSaved();
    } catch {
      setErr("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 space-y-3">
      {err && <Alert tone="danger">{err}</Alert>}
      <Field label="Owner">
        <Input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="e.g. Afra" />
      </Field>
      <Field label="Access level">
        <Select
          value={access}
          onChange={(e) => setAccess(e.target.value)}
          options={ACCESS_LEVELS.map((a) => ({ value: a.value, label: `${a.label} — ${a.scope}` }))}
        />
      </Field>
      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Allowed work modes</legend>
        <div className="flex flex-wrap gap-1">
          {WORK_MODES.map((m) => {
            const on = modes.has(m);
            return (
              <button
                key={m}
                type="button"
                aria-pressed={on}
                onClick={() => setModes((p) => { const n = new Set(p); if (n.has(m)) n.delete(m); else n.add(m); return n; })}
                className={cn(
                  "inline-flex h-7 items-center rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  on
                    ? "border-accent/30 bg-accent-soft text-accent-strong"
                    : "border-border text-muted-foreground hover:bg-surface-muted hover:text-foreground"
                )}
              >
                {MODE_LABELS[m]}
              </button>
            );
          })}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Review (days)">
          <Input type="number" min={0} value={review} onChange={(e) => setReview(e.target.value)} />
        </Field>
        <Field label="Retention (days)">
          <Input type="number" min={0} value={retention} onChange={(e) => setRetention(e.target.value)} placeholder="Keep" />
        </Field>
      </div>
      <fieldset className="rounded-xl border border-border px-3 pb-1.5 pt-1">
        <legend className="px-1 text-xs font-medium text-muted-foreground">Chatbot eligibility</legend>
        <EditCheck label="CEO Copilot" checked={ceo} onChange={setCeo} />
        <EditCheck label="Employee chat" checked={team} onChange={setTeam} />
        <EditCheck label="Client-facing generation" checked={client} onChange={setClient} />
      </fieldset>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="secondary" size="toolbar" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="toolbar" onClick={save} loading={busy}>
          {!busy && <Save size={14} aria-hidden />}
          Save
        </Button>
      </div>
    </div>
  );
}

function EditCheck({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  const labelId = React.useId();
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span id={labelId} className="text-[13px] text-foreground">
        {label}
      </span>
      <Switch checked={checked} onChange={onChange} aria-labelledby={labelId} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right: document inspector (+ chunk drill-down)
// ---------------------------------------------------------------------------
interface InspectChunk { id: string; content: string; context: string | null; parentId: string | null; tokenCount: number | null; isParent: boolean; retrievals: number; citations: number; lastRetrieved: string | null; avgScore: number | null }
interface InspectStats { totalRetrievals: number; citations: number; lastRetrieved: string | null }
interface InspectRun { status: string; trigger: string; chunks: number; error: string | null; startedAt: string; finishedAt: string | null }


function DocumentInspector({
  d,
  busy,
  error,
  onClose,
  onReprocess,
}: {
  d: WsDocument;
  busy: boolean;
  /** The last action on this document failed with this message. */
  error?: string;
  onClose: () => void;
  onReprocess: () => void;
}) {
  const [chunks, setChunks] = React.useState<InspectChunk[] | null>(null);
  const [stats, setStats] = React.useState<InspectStats | null>(null);
  const [runs, setRuns] = React.useState<InspectRun[]>([]);
  const [openChunk, setOpenChunk] = React.useState<string | null>(null);
  // A failed inspect fetch is its own state: it must never read as "no chunks".
  const [failed, setFailed] = React.useState(false);
  // Bumped by Retry to re-run the same loader.
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setChunks(null);
    setStats(null);
    setRuns([]);
    setOpenChunk(null);
    setFailed(false);
    (async () => {
      try {
        const res = await fetch(`/api/admin/documents/${d.id}/inspect`, { cache: "no-store" });
        if (res.ok && !cancelled) {
          const data = (await res.json()) as { chunks: InspectChunk[]; stats?: InspectStats; runs?: InspectRun[] };
          setChunks(data.chunks ?? []);
          setStats(data.stats ?? null);
          setRuns(data.runs ?? []);
        } else if (!cancelled) setFailed(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [d.id, attempt]);

  const ready = docStatus(d) === "ready";
  const restricted = docRestricted(d);
  const name = d.title || "Untitled";

  return (
    <>
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileText size={16} aria-hidden className="shrink-0 text-accent" />
            <h2 tabIndex={-1} className="truncate text-sm font-semibold text-foreground outline-none" title={name}>
              {name}
            </h2>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {sourceTypeLabel(d.sourceType)} · {docClassLabel(d)}{d.domain ? ` / ${domainLabel(d.domain)}` : ""}
          </p>
        </div>
        <IconButton aria-label={`Close details for ${name}`} size="sm" onClick={onClose}>
          <X size={16} aria-hidden />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-2 gap-2">
          <CompactStat label="Chunks" value={fmtInt(d.chunkCount)} />
          <CompactStat label="Index" value={ready ? "Indexed" : "Pending"} />
          <CompactStat label="Retrievals" value={stats ? fmtInt(stats.totalRetrievals) : "—"} />
          <CompactStat label="Citations" value={stats ? fmtInt(stats.citations) : "—"} />
        </div>
        {stats?.lastRetrieved && (
          <p className="mt-2 text-xs text-muted-foreground">
            Last retrieved <span title={fmtDateTime(stats.lastRetrieved)}>{relTime(stats.lastRetrieved)}</span>
          </p>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" size="toolbar" onClick={onReprocess} loading={busy}>
            {!busy && <RefreshCw size={14} aria-hidden />}
            Reprocess
          </Button>
          <Link href={`/dashboard/documents/${d.id}`} className={buttonClass({ variant: "ghost", size: "toolbar" })}>
            Open full page
          </Link>
        </div>
        {error && <p className="mt-2 break-words text-xs text-danger">{error}</p>}

        <InspectorSection title="Metadata">
          <DefList>
            <Def label="Class">{docClassLabel(d)}</Def>
            <Def label="Domain">{d.domain ? domainLabel(d.domain) : <Missing />}</Def>
            <Def label="Object">
              {d.objectRef && d.objectId ? (
                <Link
                  href={`/dashboard/knowledge/${d.objectId}`}
                  className="font-medium text-accent-strong hover:underline"
                >
                  <span className="font-mono">{d.objectRef}</span>
                  {d.objectName ? ` · ${d.objectName}` : ""}
                </Link>
              ) : (
                <span className="text-muted-foreground">Not compiled</span>
              )}
            </Def>
            {d.category && <Def label="Category">{humanize(d.category)}</Def>}
            <Def label="Owner">{d.owner || <Missing />}</Def>
            <Def label="Access">
              <span className="inline-flex items-center gap-1">
                {restricted && <Lock size={12} aria-hidden className="shrink-0 text-muted-foreground" />}
                {docAccess(d)}
              </span>
            </Def>
            <Def label="Review date">
              {d.reviewDate ? (
                docReviewDue(d) ? (
                  <span className="text-warning">{fmtDay(d.reviewDate)} (due)</span>
                ) : (
                  fmtDay(d.reviewDate)
                )
              ) : (
                <Missing />
              )}
            </Def>
            <Def label="Created">
              <span title={fmtDateTime(d.createdAt)}>{relTime(d.createdAt)}</span>
            </Def>
            <Def label="Updated">
              <span title={fmtDateTime(d.updatedAt)}>{relTime(d.updatedAt)}</span>
            </Def>
            {d.uri && (
              <Def label="Source">
                <span className="block truncate" title={d.uri}>
                  {d.uri}
                </span>
              </Def>
            )}
          </DefList>
        </InspectorSection>

        {runs.length > 0 && (
          <InspectorSection title="Processing runs">
            <ul className="space-y-1">
              {runs.map((r, i) => (
                <li key={i} className="rounded-lg border border-border px-2.5 py-1.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <StatusDot tone={statusTone(r.status)} className="shrink-0 text-foreground">
                        {triggerLabel(r.trigger)}
                        <span className="sr-only"> ({humanize(r.status)})</span>
                      </StatusDot>
                      <span className="truncate text-muted-foreground">· {fmtInt(r.chunks)} chunks</span>
                    </span>
                    <span className="shrink-0 text-muted-foreground" title={fmtDateTime(r.startedAt)}>
                      {relTime(r.startedAt)}
                    </span>
                  </div>
                  {r.error && (
                    <p className="mt-0.5 break-words text-danger">
                      {r.error}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </InspectorSection>
        )}

        <InspectorSection id={INSPECTOR_CHUNKS_ID} title={`Chunks${chunks ? ` (${fmtInt(chunks.length)})` : ""}`}>
          {failed ? (
            <Alert tone="danger">
              <p>Couldn&apos;t load this document&apos;s chunks.</p>
              <Button variant="secondary" size="toolbar" className="mt-2" onClick={() => setAttempt((a) => a + 1)}>
                <RefreshCw size={14} aria-hidden />
                Retry
              </Button>
            </Alert>
          ) : chunks === null ? (
            <Spinner label="Loading chunks…" className="py-3 text-xs" />
          ) : chunks.length === 0 ? (
            <p className="py-3 text-xs text-muted-foreground">No chunks yet — this document isn&apos;t searchable.</p>
          ) : (
            <ul className="space-y-1">
              {chunks.map((ch, i) => {
                const open = openChunk === ch.id;
                const panelId = `ws-chunk-${ch.id}`;
                return (
                  <li key={ch.id}>
                    <button
                      type="button"
                      onClick={() => setOpenChunk((o) => (o === ch.id ? null : ch.id))}
                      aria-expanded={open}
                      aria-controls={panelId}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        open ? "border-accent/30 bg-accent-soft" : "border-border bg-surface hover:bg-surface-muted"
                      )}
                    >
                      <span className={cn("shrink-0 text-[11px] tabular-nums", open ? "text-accent-strong" : "text-muted-foreground")}>
                        #{i + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-foreground">{ch.content.slice(0, 80)}</span>
                      {ch.isParent && <Tag className="shrink-0">Parent</Tag>}
                      <ChevronRight
                        size={14}
                        aria-hidden
                        className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
                      />
                    </button>
                    {open && (
                      <div id={panelId} className="mt-1 rounded-lg border border-border bg-surface p-2.5">
                        {ch.context && <p className="mb-2 text-xs italic text-muted-foreground">{ch.context}</p>}
                        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">{ch.content}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                          <span>
                            Position {i + 1} of {chunks.length}
                          </span>
                          {ch.tokenCount ? <span>{ch.tokenCount} tokens</span> : null}
                          <span>Retrieved {ch.retrievals}×</span>
                          {ch.avgScore !== null && <span>Score {ch.avgScore.toFixed(2)}</span>}
                          {ch.citations > 0 && <span className="text-accent-strong">Cited {ch.citations}×</span>}
                          {ch.lastRetrieved && <span>Last {relTime(ch.lastRetrieved)}</span>}
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </InspectorSection>
      </div>
    </>
  );
}

// ---- New collection ---------------------------------------------------------
function NewCollectionButton({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/collections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (res.ok) {
        setName("");
        setOpen(false);
        onCreated();
      } else {
        // Previously a failure closed nothing and said nothing; show the reason.
        const j = await res.json().catch(() => ({}));
        setError(typeof j.error === "string" && j.error ? j.error : `Couldn't create the collection (${res.status}).`);
      }
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        size="toolbar"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <Plus size={14} aria-hidden />
        New collection
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title="New collection"
        description="Group related documents so they can be governed and scoped together."
        size="sm"
        closeOnBackdrop={false}
        dismissible={!busy}
        footer={
          <>
            <Button variant="secondary" size="toolbar" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="toolbar" onClick={create} loading={busy} disabled={!name.trim()}>
              {!busy && <Plus size={14} aria-hidden />}
              Create
            </Button>
          </>
        }
      >
        <Field label="Name" error={error}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
            placeholder="Collection name"
          />
        </Field>
      </Dialog>
    </>
  );
}
