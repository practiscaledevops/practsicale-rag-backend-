"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FileText,
  Loader2,
  Trash2,
  Search,
  MoreHorizontal,
  Eye,
  RefreshCw,
  Layers,
  Lock,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Card, CardContent } from "@/components/ui/Card";
import { Table, THead, TBody, Tr, Th, Td } from "@/components/ui/Table";
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
}

const SOURCE_LABELS: Record<string, string> = {
  document: "Document",
  call_score: "Call score",
  coaching: "Coaching",
  transcript: "Transcript",
};
const sourceLabel = (v: string) => SOURCE_LABELS[v] ?? v;

const SOURCE_FILTERS = ["all", "document", "call_score", "coaching", "transcript"] as const;

/** Freshness from the review date (if any) else the last-updated age. */
function freshness(updatedAt: string, reviewDate: string | null): { label: string; tone: "success" | "warning" | "danger" } {
  if (reviewDate) {
    const r = new Date(reviewDate).getTime();
    if (!Number.isNaN(r) && r < Date.now()) return { label: "Review due", tone: "danger" };
  }
  const days = Math.floor((Date.now() - new Date(updatedAt).getTime()) / 86_400_000);
  if (Number.isNaN(days)) return { label: "—", tone: "warning" };
  if (days < 30) return { label: "Fresh", tone: "success" };
  if (days < 90) return { label: "Aging", tone: "warning" };
  return { label: "Stale", tone: "danger" };
}

const ACCESS_LABEL: Record<string, string> = {
  restricted: "Restricted",
  confidential: "Confidential",
  ceo_only: "CEO only",
  team: "Team",
  public: "Public",
};
function accessLabel(v: string | null, sourceType: string): string {
  if (v) return ACCESS_LABEL[v.toLowerCase()] ?? v;
  return sourceType === "call_score" ? "Restricted" : "Team";
}

export function DocumentsClient({ documents }: { documents: DocumentRow[] }) {
  const router = useRouter();
  const [target, setTarget] = React.useState<DocumentRow | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<(typeof SOURCE_FILTERS)[number]>("all");
  const [reprocessing, setReprocessing] = React.useState<string | null>(null);
  const [menuFor, setMenuFor] = React.useState<string | null>(null);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return documents.filter((d) => {
      if (filter !== "all" && d.source_type !== filter) return false;
      if (!q) return true;
      return `${d.title ?? ""} ${d.collection ?? ""} ${d.category ?? ""} ${d.owner ?? ""}`
        .toLowerCase()
        .includes(q);
    });
  }, [documents, query, filter]);

  async function confirmDelete() {
    if (!target) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/documents?id=${encodeURIComponent(target.id)}`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `Delete failed (${res.status})`);
        return;
      }
      setTarget(null);
      router.refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setDeleting(false);
    }
  }

  async function reprocess(id: string) {
    setMenuFor(null);
    setReprocessing(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/documents/${encodeURIComponent(id)}/reingest`, {
        method: "POST",
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error ?? `Reprocess failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setReprocessing(null);
    }
  }

  if (documents.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="No documents yet"
        description="Upload a file or sync a data source to populate the knowledge base."
      />
    );
  }

  return (
    <>
      {error && (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      {/* Toolbar: search + type filter */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-border bg-surface px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title, collection, category, owner…"
            className="w-full bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {SOURCE_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                filter === f
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border text-muted-foreground hover:bg-surface-muted"
              )}
            >
              {f === "all" ? "All" : sourceLabel(f)}
            </button>
          ))}
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <Tr>
                  <Th>Title</Th>
                  <Th>Collection</Th>
                  <Th>Category</Th>
                  <Th>Type</Th>
                  <Th>Access</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Chunks</Th>
                  <Th>Freshness</Th>
                  <Th>Updated</Th>
                  <Th className="text-right">Actions</Th>
                </Tr>
              </THead>
              <TBody>
                {filtered.map((d) => {
                  const fresh = freshness(d.updated_at, d.review_date);
                  const indexed = d.chunk_count > 0;
                  return (
                    <Tr key={d.id}>
                      <Td className="font-medium">
                        <Link href={`/dashboard/documents/${d.id}`} className="text-accent hover:underline">
                          {d.title || <span className="italic text-muted-foreground">Untitled</span>}
                        </Link>
                      </Td>
                      <Td className="text-muted-foreground">{d.collection || "—"}</Td>
                      <Td className="text-muted-foreground">{d.category || "—"}</Td>
                      <Td>
                        <Badge tone="accent">{sourceLabel(d.source_type)}</Badge>
                      </Td>
                      <Td>
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          {(d.source_type === "call_score" || (d.access ?? "").toLowerCase().includes("restrict")) && (
                            <Lock className="h-3 w-3" aria-hidden />
                          )}
                          {accessLabel(d.access, d.source_type)}
                        </span>
                      </Td>
                      <Td>
                        <Badge tone={indexed ? "success" : "warning"}>
                          {indexed ? "Indexed" : "Pending"}
                        </Badge>
                      </Td>
                      <Td className="text-right tabular-nums">{d.chunk_count.toLocaleString()}</Td>
                      <Td>
                        <Badge tone={fresh.tone}>{fresh.label}</Badge>
                      </Td>
                      <Td className="whitespace-nowrap text-muted-foreground">
                        {new Date(d.updated_at).toLocaleDateString()}
                      </Td>
                      <Td className="text-right">
                        <RowMenu
                          open={menuFor === d.id}
                          onToggle={() => setMenuFor((m) => (m === d.id ? null : d.id))}
                          onClose={() => setMenuFor(null)}
                          docId={d.id}
                          reprocessing={reprocessing === d.id}
                          onReprocess={() => reprocess(d.id)}
                          onDelete={() => {
                            setMenuFor(null);
                            setError(null);
                            setTarget(d);
                          }}
                        />
                      </Td>
                    </Tr>
                  );
                })}
                {filtered.length === 0 && (
                  <Tr>
                    <Td className="py-8 text-center text-muted-foreground" colSpan={10}>
                      No documents match your filters.
                    </Td>
                  </Tr>
                )}
              </TBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <p className="mt-3 text-xs text-muted-foreground">
        {filtered.length.toLocaleString()} of {documents.length.toLocaleString()} documents
      </p>

      <Dialog
        open={target !== null}
        onClose={() => (deleting ? undefined : setTarget(null))}
        title="Delete document?"
        description={
          target
            ? `“${target.title || "Untitled"}” will be permanently removed, taking ${target.chunk_count} chunk${
                target.chunk_count === 1 ? "" : "s"
              } out of retrieval. This cannot be undone.`
            : undefined
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDelete} disabled={deleting}>
              {deleting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              )}
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </>
        }
      />
    </>
  );
}

/** Three-dot row action menu (replaces the bare red Delete). */
function RowMenu({
  open,
  onToggle,
  onClose,
  docId,
  reprocessing,
  onReprocess,
  onDelete,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  docId: string;
  reprocessing: boolean;
  onReprocess: () => void;
  onDelete: () => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onClose]);

  return (
    <div className="relative inline-flex" ref={ref}>
      <Button variant="ghost" size="sm" onClick={onToggle} aria-label="Document actions" aria-haspopup="menu" aria-expanded={open}>
        {reprocessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 w-52 rounded-xl border border-border bg-surface p-1 text-left shadow-lg"
        >
          <MenuItem icon={Eye} label="View details" href={`/dashboard/documents/${docId}`} />
          <MenuItem icon={Layers} label="View chunks" href={`/dashboard/documents/${docId}`} />
          <button
            type="button"
            role="menuitem"
            onClick={onReprocess}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-foreground transition-colors hover:bg-surface-muted"
          >
            <RefreshCw className="h-4 w-4 text-muted-foreground" aria-hidden />
            Reprocess
          </button>
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            role="menuitem"
            onClick={onDelete}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-danger transition-colors hover:bg-danger/10"
          >
            <Trash2 className="h-4 w-4" aria-hidden />
            Delete permanently
          </button>
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, label, href }: { icon: typeof Eye; label: string; href: string }) {
  return (
    <Link
      href={href}
      role="menuitem"
      className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-foreground transition-colors hover:bg-surface-muted"
    >
      <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
      {label}
    </Link>
  );
}
