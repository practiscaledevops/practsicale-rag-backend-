"use client";

// Knowledge control center — a fixed 3-pane operational workspace:
//   collections (left) → documents (middle) → detail inspector (right).
// The page itself never scrolls; each pane scrolls independently. Deep green
// palette per the Brain brand. Live counts are derived from the documents +
// collections passed in; the document inspector lazy-loads chunks. Every
// document is shown with its Operating Intelligence lane (class · domain) and,
// when it backs a compiled knowledge object, that object's ref.

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Folder,
  FolderOpen,
  Library,
  FileText,
  Database,
  Lock,
  Search,
  Plus,
  MoreHorizontal,
  RefreshCw,
  Trash2,
  Eye,
  Layers,
  FlaskConical,
  Loader2,
  ChevronRight,
  X,
  Pencil,
  Save,
} from "lucide-react";
import { WORK_MODES, MODE_LABELS } from "@/lib/prompts";
import { ACCESS_LEVELS } from "@/lib/knowledge-taxonomy";
import { INTELLIGENCE_CLASSES, domainLabel, humanize } from "@/lib/intelligence-taxonomy";

// ---- Green palette (self-contained; independent of global tokens) -----------
const C = {
  bg: "#06100D",
  sidebar: "#091914",
  surface: "#0D1E18",
  raised: "#122B23",
  border: "#204438",
  text: "#EDF7F2",
  muted: "#91AAA0",
  green: "#00BFAE",
  restricted: "#94DCA7",
  amber: "#F3B661",
  red: "#FF7B75",
};

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

// source_type "document" is everything not synced from an API: uploads, pasted
// text, links and compiled knowledge objects.
const SOURCE_LABEL: Record<string, string> = {
  document: "Manual",
  call_score: "Call score",
  coaching: "Coaching",
  transcript: "Transcript",
};
const ACCESS_LABEL: Record<string, string> = {
  team: "Team",
  restricted: "Restricted",
  confidential: "Confidential",
  ceo_only: "CEO only",
  public: "Public",
};
const RESTRICTED = new Set(["restricted", "confidential", "ceo_only"]);
const STALE_DAYS = 90;

function ageDays(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : Math.floor((Date.now() - t) / 86_400_000);
}
function relTime(iso: string | null): string {
  if (!iso) return "—";
  const d = ageDays(iso);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}
function docAccess(d: WsDocument): string {
  if (d.access) return ACCESS_LABEL[d.access.toLowerCase()] ?? d.access;
  return d.sourceType === "call_score" ? "Restricted" : "Team";
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
  if (d.intelligenceClass === "raw_archive") return "Raw archive";
  const id = d.intelligenceClass ?? "business_reality";
  return INTELLIGENCE_CLASSES.find((c) => c.id === id)?.label ?? humanize(id);
}
/** The compiled page of a knowledge object (raw sources link to their object but are not "compiled"). */
function docCompiled(d: WsDocument): boolean {
  return Boolean(d.objectId) && d.intelligenceClass !== "raw_archive";
}

const FILTERS = [
  ["all", "All"],
  ["compiled", "Compiled"],
  ["raw", "Raw archive"],
  ["call_score", "Call score"],
  ["document", "Manual"],
  ["ready", "Ready"],
  ["processing", "Processing"],
  ["review", "Needs review"],
  ["restricted", "Restricted"],
  ["recent", "Updated recently"],
] as const;
type FilterKey = (typeof FILTERS)[number][0];

// Shared by the fixed header and every row so the columns stay aligned.
const DOC_GRID = "minmax(0,2.2fr) minmax(0,1.5fr) 0.8fr 0.6fr 0.8fr 0.7fr 28px";

// A synthetic id for the "All documents" and "Unfiled" pseudo-collections.
const ALL = "__all__";
const UNFILED = "__unfiled__";

export function KnowledgeWorkspace({
  collections,
  documents,
  governanceEnabled,
}: {
  collections: WsCollection[];
  documents: WsDocument[];
  governanceEnabled: boolean;
}) {
  const router = useRouter();
  const [selectedCol, setSelectedCol] = React.useState<string>(ALL);
  const [selectedDoc, setSelectedDoc] = React.useState<string | null>(null);
  const [colSearch, setColSearch] = React.useState("");
  const [filter, setFilter] = React.useState<FilterKey>("all");
  const [docSearch, setDocSearch] = React.useState("");
  const [busyDoc, setBusyDoc] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  // Membership index: collectionId -> docs.
  const byCollection = React.useMemo(() => {
    const m = new Map<string, WsDocument[]>();
    for (const d of documents) {
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
  }, [documents]);

  // Enriched collection rows (chunk totals, freshness, health, attention).
  const enriched = React.useMemo(() => {
    return collections.map((c) => {
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
      return { c, docs, chunks, lastUpdated, failing, stale, restricted, sourceKind, attention };
    });
  }, [collections, byCollection]);

  const filteredCols = React.useMemo(() => {
    const q = colSearch.trim().toLowerCase();
    if (!q) return enriched;
    return enriched.filter((e) => e.c.name.toLowerCase().includes(q));
  }, [enriched, colSearch]);

  // Documents for the middle pane.
  const paneDocs = React.useMemo(() => {
    let docs =
      selectedCol === ALL ? documents : selectedCol === UNFILED ? byCollection.get(UNFILED) ?? [] : byCollection.get(selectedCol) ?? [];
    // filter
    docs = docs.filter((d) => {
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
    });
    const q = docSearch.trim().toLowerCase();
    if (q) {
      docs = docs.filter((d) =>
        `${d.title ?? ""} ${d.objectRef ?? ""} ${d.objectName ?? ""} ${docClassLabel(d)} ${domainLabel(d.domain)} ${d.category ?? ""} ${d.owner ?? ""}`
          .toLowerCase()
          .includes(q)
      );
    }
    return docs;
  }, [selectedCol, filter, docSearch, documents, byCollection]);

  const selectedCollection = collections.find((c) => c.id === selectedCol) ?? null;
  const selectedDocument = documents.find((d) => d.id === selectedDoc) ?? null;

  function pickCollection(id: string) {
    setSelectedCol(id);
    setSelectedDoc(null);
    setFilter("all");
    setDocSearch("");
  }

  async function reprocess(id: string) {
    setBusyDoc(id);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/documents/${id}/reingest`, { method: "POST" });
      setNotice(res.ok ? "Reprocessing started." : "Reprocess failed.");
      if (res.ok) router.refresh();
    } finally {
      setBusyDoc(null);
    }
  }
  async function del(id: string) {
    if (!confirm("Delete this document and its chunks permanently? This can't be undone.")) return;
    setBusyDoc(id);
    try {
      const res = await fetch(`/api/admin/documents?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.ok) {
        if (selectedDoc === id) setSelectedDoc(null);
        router.refresh();
      } else setNotice("Delete failed.");
    } finally {
      setBusyDoc(null);
    }
  }

  const totalDocs = documents.length;
  const totalChunks = documents.reduce((n, d) => n + d.chunkCount, 0);

  return (
    <div
      className="-m-4 grid h-[calc(100vh-4rem)] overflow-hidden text-[13px] lg:-m-6"
      style={{ backgroundColor: C.bg, color: C.text, gridTemplateColumns: "300px minmax(0,1fr) 340px" }}
    >
      {/* ============ LEFT: collections ============ */}
      <section className="flex min-h-0 flex-col border-r" style={{ borderColor: C.border, backgroundColor: C.sidebar }}>
        <div className="shrink-0 border-b p-3" style={{ borderColor: C.border }}>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Library size={16} style={{ color: C.green }} /> Collections
            </h2>
            <NewCollectionButton onCreated={() => router.refresh()} />
          </div>
          <div className="flex items-center gap-2 rounded-lg border px-2.5" style={{ borderColor: C.border, backgroundColor: C.surface }}>
            <Search size={13} style={{ color: C.muted }} />
            <input
              value={colSearch}
              onChange={(e) => setColSearch(e.target.value)}
              placeholder="Search collections"
              className="w-full bg-transparent py-2 text-xs outline-none"
              style={{ color: C.text }}
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <CollectionRow
            active={selectedCol === ALL}
            onClick={() => pickCollection(ALL)}
            icon={<Database size={16} style={{ color: C.green }} />}
            name="All documents"
            sub={`${totalDocs} docs · ${totalChunks.toLocaleString()} chunks`}
          />
          {filteredCols.map((e) => (
            <CollectionRow
              key={e.c.id}
              active={selectedCol === e.c.id}
              onClick={() => pickCollection(e.c.id)}
              icon={e.restricted ? <Lock size={15} style={{ color: C.restricted }} /> : <Folder size={16} style={{ color: C.green }} />}
              name={e.c.name}
              sub={`${e.docs.length} docs · ${e.chunks.toLocaleString()} chunks`}
              meta={e.sourceKind}
              attention={e.attention}
              updated={relTime(e.lastUpdated)}
            />
          ))}
          {(byCollection.get(UNFILED)?.length ?? 0) > 0 && (
            <CollectionRow
              active={selectedCol === UNFILED}
              onClick={() => pickCollection(UNFILED)}
              icon={<FolderOpen size={16} style={{ color: C.muted }} />}
              name="Unfiled"
              sub={`${byCollection.get(UNFILED)!.length} docs`}
            />
          )}
        </div>
      </section>

      {/* ============ MIDDLE: documents ============ */}
      <section className="flex min-h-0 flex-col" style={{ backgroundColor: C.surface }}>
        <div className="shrink-0 border-b p-3" style={{ borderColor: C.border }}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h1 className="truncate text-base font-semibold">
              {selectedCol === ALL ? "All documents" : selectedCol === UNFILED ? "Unfiled" : selectedCollection?.name ?? "Documents"}
            </h1>
            <div className="flex items-center gap-2 rounded-lg border px-2.5" style={{ borderColor: C.border, backgroundColor: C.bg }}>
              <Search size={13} style={{ color: C.muted }} />
              <input
                value={docSearch}
                onChange={(e) => setDocSearch(e.target.value)}
                placeholder="Search documents"
                className="w-44 bg-transparent py-1.5 text-xs outline-none"
                style={{ color: C.text }}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            {FILTERS.map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                title={k === "document" ? "Uploaded, pasted, linked or compiled — not synced from an API" : undefined}
                className="rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors"
                style={
                  filter === k
                    ? { borderColor: C.green, color: C.green, backgroundColor: "rgba(0,191,174,0.12)" }
                    : { borderColor: C.border, color: C.muted }
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {notice && (
          <div className="shrink-0 px-3 py-1.5 text-[11px]" style={{ color: C.green }}>{notice}</div>
        )}

        {/* Fixed table header */}
        <div
          className="grid shrink-0 items-center gap-2 border-b px-3 py-2 text-[10px] font-semibold uppercase tracking-wider"
          style={{ borderColor: C.border, color: C.muted, gridTemplateColumns: DOC_GRID }}
        >
          <span>Document</span>
          <span>Class · Domain</span>
          <span>Access</span>
          <span className="text-right">Chunks</span>
          <span>Status</span>
          <span>Updated</span>
          <span />
        </div>

        {/* Scrolling body */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {paneDocs.length === 0 ? (
            <p className="p-8 text-center text-xs" style={{ color: C.muted }}>No documents match.</p>
          ) : (
            paneDocs.map((d) => (
              <DocRow
                key={d.id}
                d={d}
                active={selectedDoc === d.id}
                busy={busyDoc === d.id}
                onSelect={() => setSelectedDoc(d.id)}
                onReprocess={() => reprocess(d.id)}
                onDelete={() => del(d.id)}
                onPlayground={() => router.push("/dashboard/playground")}
              />
            ))
          )}
        </div>
        <div className="shrink-0 border-t px-3 py-1.5 text-[11px]" style={{ borderColor: C.border, color: C.muted }}>
          {paneDocs.length.toLocaleString()} shown
        </div>
      </section>

      {/* ============ RIGHT: detail inspector ============ */}
      <aside className="flex min-h-0 flex-col border-l" style={{ borderColor: C.border, backgroundColor: C.sidebar }}>
        {selectedDocument ? (
          <DocumentInspector d={selectedDocument} onClose={() => setSelectedDoc(null)} onReprocess={() => reprocess(selectedDocument.id)} />
        ) : selectedCol !== ALL && selectedCol !== UNFILED && selectedCollection ? (
          <CollectionInspector
            c={selectedCollection}
            enriched={enriched.find((e) => e.c.id === selectedCollection.id)}
            governanceEnabled={governanceEnabled}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <Library size={28} style={{ color: C.border }} />
            <p className="text-sm font-medium">Knowledge inspector</p>
            <p className="text-xs" style={{ color: C.muted }}>
              Select a collection or a document to see its details, chunks, and health.
            </p>
          </div>
        )}
      </aside>
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
  sub,
  meta,
  attention,
  updated,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  name: string;
  sub: string;
  meta?: string;
  attention?: string | null;
  updated?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-0.5 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors"
      style={active ? { backgroundColor: "rgba(0,191,174,0.12)" } : undefined}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.04)"; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.backgroundColor = "transparent"; }}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium" style={{ color: active ? C.green : C.text }}>{name}</span>
          {attention && <AttentionDot kind={attention} />}
        </span>
        <span className="mt-0.5 block truncate text-[11px]" style={{ color: C.muted }}>{sub}</span>
        {(meta || updated) && (
          <span className="mt-0.5 block truncate text-[10px]" style={{ color: C.muted }}>
            {meta}{meta && updated ? " · " : ""}{updated ? `updated ${updated}` : ""}
          </span>
        )}
      </span>
    </button>
  );
}

function AttentionDot({ kind }: { kind: string }) {
  const color = kind === "fail" ? C.red : kind === "restricted" ? C.restricted : C.amber;
  const label = kind === "fail" ? "Has failing documents" : kind === "stale" ? "Stale knowledge" : kind === "owner" ? "No owner" : "Restricted";
  return <span title={label} className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}

// ---------------------------------------------------------------------------
// Middle: document row (+ 3-dot menu)
// ---------------------------------------------------------------------------
/** The object's stable ref (BR-SAL-003), linking to its page. Muted for a raw source, green for the compiled page. */
function RefChip({ d }: { d: WsDocument }) {
  if (!d.objectRef || !d.objectId) return null;
  const compiled = docCompiled(d);
  return (
    <Link
      href={`/dashboard/knowledge/${d.objectId}`}
      onClick={(e) => e.stopPropagation()}
      title={`${compiled ? "Open knowledge object" : "Raw source of"} ${d.objectName ?? d.objectRef}`}
      className="shrink-0 rounded px-1 font-mono text-[10px] leading-4 hover:underline"
      style={compiled ? { color: C.green, border: "1px solid rgba(0,191,174,0.35)" } : { color: C.muted, border: `1px solid ${C.border}` }}
    >
      {d.objectRef}
    </Link>
  );
}

function DocRow({
  d,
  active,
  busy,
  onSelect,
  onReprocess,
  onDelete,
  onPlayground,
}: {
  d: WsDocument;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  onReprocess: () => void;
  onDelete: () => void;
  onPlayground: () => void;
}) {
  const [menu, setMenu] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!menu) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setMenu(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [menu]);

  const ready = docStatus(d) === "ready";
  const restricted = RESTRICTED.has((d.access ?? "").toLowerCase()) || d.sourceType === "call_score";
  return (
    <div
      className="grid cursor-pointer items-center gap-2 border-b px-3 py-2 transition-colors"
      style={{ borderColor: "rgba(32,68,56,0.5)", gridTemplateColumns: DOC_GRID, backgroundColor: active ? "rgba(0,191,174,0.10)" : undefined }}
      onClick={onSelect}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.03)"; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.backgroundColor = active ? "rgba(0,191,174,0.10)" : "transparent"; }}
    >
      <span className="flex min-w-0 items-center gap-2">
        <FileText size={14} style={{ color: C.muted }} className="shrink-0" />
        <span className="truncate font-medium" style={{ color: C.text }}>{d.title || "Untitled"}</span>
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate" style={{ color: C.text }}>
            {docClassLabel(d)}
            {d.domain && <span style={{ color: C.muted }}> · {domainLabel(d.domain)}</span>}
          </span>
          <RefChip d={d} />
        </span>
        {d.category && <span className="truncate text-[10px]" style={{ color: C.muted }}>{humanize(d.category)}</span>}
      </span>
      <span className="flex items-center gap-1 truncate" style={{ color: C.muted }}>
        {restricted && <Lock size={11} style={{ color: C.restricted }} />}{docAccess(d)}
      </span>
      <span className="text-right tabular-nums" style={{ color: C.text }}>{d.chunkCount}</span>
      <span>
        <span className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={ready ? { backgroundColor: "rgba(0,191,174,0.15)", color: C.green } : { backgroundColor: "rgba(243,182,97,0.15)", color: C.amber }}>
          {ready ? "Ready" : "Processing"}
        </span>
      </span>
      <span className="tabular-nums" style={{ color: C.muted }}>{relTime(d.updatedAt)}</span>
      <span className="relative flex justify-end" ref={ref} onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => setMenu((m) => !m)} className="grid h-6 w-6 place-items-center rounded" style={{ color: C.muted }} aria-label="Actions">
          {busy ? <Loader2 size={13} className="animate-spin" /> : <MoreHorizontal size={14} />}
        </button>
        {menu && (
          <div className="absolute right-0 top-full z-20 mt-1 w-48 rounded-lg border p-1 shadow-lg" style={{ borderColor: C.border, backgroundColor: C.raised }}>
            <MenuItem icon={Eye} label="Open details" onClick={() => { setMenu(false); onSelect(); }} />
            <MenuItem icon={Layers} label="View chunks" onClick={() => { setMenu(false); onSelect(); }} />
            <MenuItem icon={FlaskConical} label="Test retrieval" onClick={() => { setMenu(false); onPlayground(); }} />
            <MenuItem icon={RefreshCw} label="Reprocess" onClick={() => { setMenu(false); onReprocess(); }} />
            <div className="my-1 border-t" style={{ borderColor: C.border }} />
            <MenuItem icon={Trash2} label="Delete permanently" danger onClick={() => { setMenu(false); onDelete(); }} />
          </div>
        )}
      </span>
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: typeof Eye; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors"
      style={{ color: danger ? C.red : C.text }}
      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.05)")}
      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
    >
      <Icon size={13} style={{ color: danger ? C.red : C.muted }} />
      {label}
    </button>
  );
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

  return (
    <>
      <div className="flex shrink-0 items-start justify-between gap-2 border-b p-4" style={{ borderColor: C.border }}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {enriched?.restricted ? <Lock size={16} style={{ color: C.restricted }} /> : <Folder size={16} style={{ color: C.green }} />}
            <h2 className="truncate text-sm font-semibold">{c.name}</h2>
          </div>
          {c.description && <p className="mt-1 text-xs" style={{ color: C.muted }}>{c.description}</p>}
        </div>
        {governanceEnabled && !editing && (
          <button type="button" onClick={() => setEditing(true)} className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px]" style={{ borderColor: C.border, color: C.muted }}>
            <Pencil size={11} /> Edit
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Documents" value={docs.length.toLocaleString()} />
          <Stat label="Chunks" value={(enriched?.chunks ?? 0).toLocaleString()} />
          <Stat label="Failing" value={String(enriched?.failing ?? 0)} tone={(enriched?.failing ?? 0) > 0 ? "bad" : "ok"} />
          <Stat label="Stale (90d+)" value={String(enriched?.stale ?? 0)} tone={(enriched?.stale ?? 0) > 0 ? "warn" : "ok"} />
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
            <Section title="Governance">
              <Row label="Owner">{s.owner || <Missing />}</Row>
              <Row label="Access level">{ACCESS_LABEL[s.access_level ?? ""] ?? "Team"}</Row>
              <Row label="Source">{enriched?.sourceKind ?? "—"}</Row>
              <Row label="Last updated">{relTime(enriched?.lastUpdated ?? null)}</Row>
              <Row label="Review cycle">{s.review_interval_days ? `${s.review_interval_days} days` : <Missing />}</Row>
              <Row label="Retention">{s.retention_days ? `${s.retention_days} days` : "Keep"}</Row>
            </Section>

            <Section title="Chatbot eligibility">
              <div className="flex flex-wrap gap-1.5">
                {s.ceo_copilot_eligible !== false && <Chip>CEO Copilot</Chip>}
                {s.employee_chat_eligible !== false && <Chip>Team chat</Chip>}
                {s.client_facing_eligible && <Chip tone="warn">Client-facing</Chip>}
              </div>
              {(s.allowed_work_modes?.length ?? 0) > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {s.allowed_work_modes!.map((m) => <Chip key={m}>{MODE_LABELS[m as keyof typeof MODE_LABELS] ?? m.replace(/_/g, " ")}</Chip>)}
                </div>
              )}
            </Section>

            {!governanceEnabled && (
              <p className="mt-4 rounded-lg border p-2 text-[11px]" style={{ borderColor: C.amber, color: C.amber, backgroundColor: "rgba(243,182,97,0.08)" }}>
                Governance fields need migration 0013_collection_settings.sql.
              </p>
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

  const field = "w-full rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none";
  const fieldStyle = { borderColor: C.border, color: C.text };

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
    <div className="mt-4 space-y-3">
      {err && <p className="text-[11px]" style={{ color: C.red }}>{err}</p>}
      <div>
        <label className="mb-1 block text-[10px] uppercase tracking-wider" style={{ color: C.muted }}>Owner</label>
        <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="e.g. Afra" className={field} style={fieldStyle} />
      </div>
      <div>
        <label className="mb-1 block text-[10px] uppercase tracking-wider" style={{ color: C.muted }}>Access level</label>
        <select value={access} onChange={(e) => setAccess(e.target.value)} className={field} style={{ ...fieldStyle, backgroundColor: C.surface }}>
          {ACCESS_LEVELS.map((a) => <option key={a.value} value={a.value} style={{ color: "#000" }}>{a.label} — {a.scope}</option>)}
        </select>
      </div>
      <div>
        <label className="mb-1 block text-[10px] uppercase tracking-wider" style={{ color: C.muted }}>Allowed work modes</label>
        <div className="flex flex-wrap gap-1">
          {WORK_MODES.map((m) => {
            const on = modes.has(m);
            return (
              <button key={m} type="button" onClick={() => setModes((p) => { const n = new Set(p); if (n.has(m)) n.delete(m); else n.add(m); return n; })}
                className="rounded-full border px-2 py-0.5 text-[10px]"
                style={on ? { borderColor: C.green, color: C.green, backgroundColor: "rgba(0,191,174,0.12)" } : { borderColor: C.border, color: C.muted }}>
                {MODE_LABELS[m]}
              </button>
            );
          })}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="mb-1 block text-[10px] uppercase tracking-wider" style={{ color: C.muted }}>Review (days)</label>
          <input type="number" min={0} value={review} onChange={(e) => setReview(e.target.value)} className={field} style={fieldStyle} />
        </div>
        <div>
          <label className="mb-1 block text-[10px] uppercase tracking-wider" style={{ color: C.muted }}>Retention (days)</label>
          <input type="number" min={0} value={retention} onChange={(e) => setRetention(e.target.value)} placeholder="keep" className={field} style={fieldStyle} />
        </div>
      </div>
      <div className="space-y-1.5 rounded-lg border p-2" style={{ borderColor: C.border }}>
        <EditCheck label="CEO Copilot" checked={ceo} onChange={setCeo} />
        <EditCheck label="Employee chat" checked={team} onChange={setTeam} />
        <EditCheck label="Client-facing generation" checked={client} onChange={setClient} />
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className="rounded-md border px-3 py-1.5 text-xs" style={{ borderColor: C.border, color: C.muted }}>Cancel</button>
        <button type="button" onClick={save} disabled={busy} className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium" style={{ backgroundColor: C.green, color: C.bg, opacity: busy ? 0.5 : 1 }}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save
        </button>
      </div>
    </div>
  );
}

function EditCheck({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs" style={{ color: C.text }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-3.5 w-3.5" style={{ accentColor: C.green }} />
      {label}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Right: document inspector (+ chunk drill-down)
// ---------------------------------------------------------------------------
interface InspectChunk { id: string; content: string; context: string | null; parentId: string | null; tokenCount: number | null; isParent: boolean; retrievals: number; citations: number; lastRetrieved: string | null; avgScore: number | null }
interface InspectStats { totalRetrievals: number; citations: number; lastRetrieved: string | null }
interface InspectRun { status: string; trigger: string; chunks: number; error: string | null; startedAt: string; finishedAt: string | null }

function DocumentInspector({ d, onClose, onReprocess }: { d: WsDocument; onClose: () => void; onReprocess: () => void }) {
  const [chunks, setChunks] = React.useState<InspectChunk[] | null>(null);
  const [stats, setStats] = React.useState<InspectStats | null>(null);
  const [runs, setRuns] = React.useState<InspectRun[]>([]);
  const [openChunk, setOpenChunk] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setChunks(null);
    setStats(null);
    setRuns([]);
    setOpenChunk(null);
    (async () => {
      try {
        const res = await fetch(`/api/admin/documents/${d.id}/inspect`, { cache: "no-store" });
        if (res.ok && !cancelled) {
          const data = (await res.json()) as { chunks: InspectChunk[]; stats?: InspectStats; runs?: InspectRun[] };
          setChunks(data.chunks ?? []);
          setStats(data.stats ?? null);
          setRuns(data.runs ?? []);
        } else if (!cancelled) setChunks([]);
      } catch {
        if (!cancelled) setChunks([]);
      }
    })();
    return () => { cancelled = true; };
  }, [d.id]);

  const ready = docStatus(d) === "ready";
  const restricted = RESTRICTED.has((d.access ?? "").toLowerCase()) || d.sourceType === "call_score";

  return (
    <>
      <div className="flex shrink-0 items-start justify-between gap-2 border-b p-4" style={{ borderColor: C.border }}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileText size={15} style={{ color: C.green }} />
            <h2 className="truncate text-sm font-semibold">{d.title || "Untitled"}</h2>
          </div>
          <p className="mt-0.5 text-[11px]" style={{ color: C.muted }}>
            {SOURCE_LABEL[d.sourceType] ?? d.sourceType} · {docClassLabel(d)}{d.domain ? ` / ${domainLabel(d.domain)}` : ""}
          </p>
        </div>
        <button type="button" onClick={onClose} className="grid h-6 w-6 shrink-0 place-items-center rounded" style={{ color: C.muted }} aria-label="Close">
          <X size={15} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Chunks" value={String(d.chunkCount)} />
          <Stat label="Index" value={ready ? "Indexed" : "Pending"} tone={ready ? "ok" : "warn"} />
          <Stat label="Retrievals" value={stats ? stats.totalRetrievals.toLocaleString() : "—"} />
          <Stat label="Citations" value={stats ? stats.citations.toLocaleString() : "—"} tone={stats && stats.citations > 0 ? "ok" : undefined} />
        </div>
        {stats?.lastRetrieved && (
          <p className="mt-2 text-[11px]" style={{ color: C.muted }}>Last retrieved {relTime(stats.lastRetrieved)}</p>
        )}

        <Section title="Metadata">
          <Row label="Class">{docClassLabel(d)}</Row>
          <Row label="Domain">{d.domain ? domainLabel(d.domain) : <Missing />}</Row>
          <Row label="Object">
            {d.objectRef && d.objectId ? (
              <Link href={`/dashboard/knowledge/${d.objectId}`} className="hover:underline" style={{ color: C.green }}>
                <span className="font-mono">{d.objectRef}</span>
                {d.objectName ? ` · ${d.objectName}` : ""}
              </Link>
            ) : (
              <span style={{ color: C.muted }}>Not compiled</span>
            )}
          </Row>
          {d.category && <Row label="Category">{humanize(d.category)}</Row>}
          <Row label="Owner">{d.owner || <Missing />}</Row>
          <Row label="Access">
            <span className="inline-flex items-center gap-1">{restricted && <Lock size={11} style={{ color: C.restricted }} />}{docAccess(d)}</span>
          </Row>
          <Row label="Review date">{d.reviewDate ? (docReviewDue(d) ? <span style={{ color: C.red }}>{d.reviewDate.slice(0, 10)} (due)</span> : d.reviewDate.slice(0, 10)) : <Missing />}</Row>
          <Row label="Created">{relTime(d.createdAt)}</Row>
          <Row label="Updated">{relTime(d.updatedAt)}</Row>
          {d.uri && <Row label="Source">{d.uri.length > 28 ? d.uri.slice(0, 28) + "…" : d.uri}</Row>}
        </Section>

        <div className="mt-2 flex gap-2">
          <button type="button" onClick={onReprocess} className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium" style={{ borderColor: C.border, color: C.text }}>
            <RefreshCw size={13} /> Reprocess
          </button>
        </div>

        {runs.length > 0 && (
          <Section title="Processing runs">
            <ul className="space-y-1">
              {runs.map((r, i) => (
                <li key={i} className="flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5 text-[11px]" style={{ borderColor: C.border, backgroundColor: C.surface }}>
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: r.status === "success" ? C.green : r.status === "error" ? C.red : C.amber }} />
                    <span className="capitalize" style={{ color: C.text }}>{r.trigger}</span>
                    <span style={{ color: C.muted }}>· {r.chunks} chunks</span>
                    {r.error && <span style={{ color: C.red }}>· {r.error.slice(0, 24)}</span>}
                  </span>
                  <span style={{ color: C.muted }}>{relTime(r.startedAt)}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section title={`Chunks${chunks ? ` (${chunks.length})` : ""}`}>
          {chunks === null ? (
            <div className="flex items-center gap-2 py-3 text-xs" style={{ color: C.muted }}>
              <Loader2 size={13} className="animate-spin" /> Loading chunks…
            </div>
          ) : chunks.length === 0 ? (
            <p className="py-3 text-xs" style={{ color: C.muted }}>No chunks yet — this document isn&apos;t searchable.</p>
          ) : (
            <ul className="space-y-1">
              {chunks.map((ch, i) => (
                <li key={ch.id}>
                  <button
                    type="button"
                    onClick={() => setOpenChunk((o) => (o === ch.id ? null : ch.id))}
                    className="flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left"
                    style={{ borderColor: C.border, backgroundColor: openChunk === ch.id ? "rgba(0,191,174,0.08)" : C.surface }}
                  >
                    <span className="shrink-0 text-[10px] tabular-nums" style={{ color: C.muted }}>#{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: C.text }}>{ch.content.slice(0, 80)}</span>
                    {ch.isParent && <span className="shrink-0 rounded px-1 text-[9px]" style={{ backgroundColor: C.raised, color: C.muted }}>parent</span>}
                    <ChevronRight size={12} style={{ color: C.muted, transform: openChunk === ch.id ? "rotate(90deg)" : undefined }} />
                  </button>
                  {openChunk === ch.id && (
                    <div className="mt-1 rounded-lg border p-2.5" style={{ borderColor: C.border, backgroundColor: C.bg }}>
                      {ch.context && (
                        <p className="mb-2 text-[11px] italic" style={{ color: C.muted }}>{ch.context}</p>
                      )}
                      <p className="whitespace-pre-wrap text-[11px] leading-relaxed" style={{ color: C.text }}>{ch.content}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]" style={{ color: C.muted }}>
                        <span>Position {i + 1} of {chunks.length}</span>
                        {ch.tokenCount ? <span>{ch.tokenCount} tokens</span> : null}
                        <span>· retrieved {ch.retrievals}×</span>
                        {ch.avgScore !== null && <span>score {ch.avgScore.toFixed(2)}</span>}
                        {ch.citations > 0 && <span style={{ color: C.green }}>cited {ch.citations}×</span>}
                        {ch.lastRetrieved && <span>last {relTime(ch.lastRetrieved)}</span>}
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}

// ---- small shared bits ------------------------------------------------------
function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "bad" }) {
  const color = tone === "bad" ? C.red : tone === "warn" ? C.amber : tone === "ok" ? C.green : C.text;
  return (
    <div className="rounded-lg border p-2.5" style={{ borderColor: C.border, backgroundColor: C.surface }}>
      <p className="text-[10px] uppercase tracking-wider" style={{ color: C.muted }}>{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums" style={{ color }}>{value}</p>
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: C.muted }}>{title}</p>
      {children}
    </div>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1 text-xs">
      <span style={{ color: C.muted }}>{label}</span>
      <span className="text-right font-medium" style={{ color: C.text }}>{children}</span>
    </div>
  );
}
function Missing() {
  return <span style={{ color: C.amber }}>Not set</span>;
}
function Chip({ children, tone }: { children: React.ReactNode; tone?: "warn" }) {
  return (
    <span className="rounded-full border px-2 py-0.5 text-[10px]" style={tone === "warn" ? { borderColor: C.amber, color: C.amber } : { borderColor: C.border, color: C.muted }}>
      {children}
    </span>
  );
}

// ---- New collection (inline) ------------------------------------------------
function NewCollectionButton({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
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
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="grid h-6 w-6 place-items-center rounded-md" style={{ color: C.green }} aria-label="New collection">
        <Plus size={15} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-56 rounded-lg border p-2 shadow-lg" style={{ borderColor: C.border, backgroundColor: C.raised }}>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") create(); }}
            placeholder="Collection name"
            className="w-full rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none"
            style={{ borderColor: C.border, color: C.text }}
          />
          <button type="button" onClick={create} disabled={busy || !name.trim()} className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium" style={{ backgroundColor: C.green, color: C.bg, opacity: busy || !name.trim() ? 0.5 : 1 }}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Create
          </button>
        </div>
      )}
    </div>
  );
}
