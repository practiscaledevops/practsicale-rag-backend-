"use client";

import * as React from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, FileText, Folder, Layers, Loader2, Lock, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { Alert, Notice } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button, buttonClass } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { SearchInput } from "@/components/ui/Input";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { useHydrated } from "@/components/ui/RelTime";
import { FilterTabs } from "@/components/ui/Tabs";
import { Table, TableCard, TableEmptyRow, TBody, Td, Th, THead, Tr } from "@/components/ui/Table";
import { fmtDate, fmtDateTime, fmtInt } from "@/lib/format";
import { ACCESS_LABELS, sourceTypeLabel, statusTone } from "@/lib/ui-labels";

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

const SOURCE_FILTERS = ["all", "document", "call_score", "coaching", "transcript"] as const;
type SourceFilter = (typeof SOURCE_FILTERS)[number];

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

export function DocumentsClient({
  documents,
  truncated = false,
}: {
  documents: DocumentRow[];
  /** The server list hit its row cap, so older documents are not shown. */
  truncated?: boolean;
}) {
  const router = useRouter();
  const [target, setTarget] = React.useState<DocumentRow | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<SourceFilter>("all");
  const [reprocessing, setReprocessing] = React.useState<string | null>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);

  // Typing stays responsive on a 1,000-row list: filtering follows a deferred copy.
  const deferredQuery = React.useDeferredValue(query);

  const searched = React.useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    if (!q) return documents;
    return documents.filter((d) =>
      `${d.title ?? ""} ${d.collection ?? ""} ${d.category ?? ""} ${d.owner ?? ""}`.toLowerCase().includes(q)
    );
  }, [documents, deferredQuery]);

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
      // Close now so the dialog hands focus back to the row's trigger, then move
      // focus off the row that the refresh is about to remove.
      flushSync(() => setTarget(null));
      searchRef.current?.focus();
      router.refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setDeleting(false);
    }
  }

  async function reprocess(id: string) {
    setReprocessing(id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/documents/${encodeURIComponent(id)}/reingest`, {
        method: "POST",
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error ?? `Reprocess failed (${res.status})`);
        return;
      }
      const doc = documents.find((d) => d.id === id);
      setNotice(`Reprocessed “${doc ? docName(doc) : "document"}”.`);
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

  const menuItems = (d: DocumentRow): MenuItem[] => [
    { label: "Open", icon: Eye, href: `/dashboard/documents/${d.id}` },
    { label: "View chunks", icon: Layers, href: `/dashboard/documents/${d.id}#chunks` },
    {
      label: "Reprocess",
      icon: RefreshCw,
      disabled: reprocessing === d.id,
      onSelect: () => reprocess(d.id),
    },
    {
      label: "Delete permanently",
      icon: Trash2,
      danger: true,
      separatorBefore: true,
      onSelect: () => {
        setError(null);
        setTarget(d);
      },
    },
  ];

  const filtersActive = query.trim() !== "" || filter !== "all";

  return (
    <>
      {/* A failed delete shows inside its dialog; everything else shows here. */}
      {error && !target && (
        <Alert tone="danger" className="mb-3" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}
      {notice && <Notice className="mb-3" message={notice} onDone={() => setNotice(null)} />}

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
            {fmtInt(filtered.length)} of {fmtInt(documents.length)} documents
            {truncated &&
              ` · Showing the first ${fmtInt(documents.length)} — use search or filters to narrow the list.`}
          </span>
        }
      >
        <Table minWidth={960} caption="Documents">
          <THead>
            <Tr>
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
              return (
                <Tr key={d.id} interactive>
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
                      trigger={
                        reprocessing === d.id ? (
                          <Loader2 size={16} aria-hidden className="animate-spin" />
                        ) : undefined
                      }
                    />
                  </Td>
                </Tr>
              );
            })}
            {filtered.length === 0 && (
              <TableEmptyRow colSpan={8}>
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

      <ConfirmDialog
        open={target !== null}
        tone="danger"
        title="Delete document?"
        description={
          target
            ? `“${docName(target)}” will be permanently removed, taking ${target.chunk_count} chunk${
                target.chunk_count === 1 ? "" : "s"
              } out of retrieval. This cannot be undone.`
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
    </>
  );
}
