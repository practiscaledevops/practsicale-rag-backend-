"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Clock,
  Layers,
  CalendarClock,
  UserX,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  ArrowRight,
  Loader2,
  RotateCcw,
} from "lucide-react";
import {
  Badge,
  BulkActionBar,
  BulkProgress,
  Button,
  Card,
  RowCheckbox,
  SectionCard,
  SelectAllCheckbox,
  SELECTED_ROW_CLASS,
  StatGrid,
  StatTile,
  buttonClass,
  useBulkRun,
  useConfirm,
  usePendingIds,
  useSelection,
  type BulkAction,
  type BulkRun,
  type RowSelectBinding,
  type SelectAllBinding,
  type StatTone,
} from "@/components/ui";
import { BULK_CONCURRENCY, HttpError, bulkErrorMessage, requestJson, type BulkVerbs } from "@/lib/bulk";
import { fmtDateTime, fmtInt, relTime } from "@/lib/format";
import { sourceTypeLabel, triggerLabel } from "@/lib/ui-labels";
import { cn } from "@/lib/utils";
import type { DataQuality, QualityDoc } from "@/lib/data-quality";

/** In-page anchors: each summary tile links to its section. */
const SECTION_IDS = {
  unsearchable: "not-searchable",
  failedRuns: "failed-runs",
  reviewDue: "review-due",
  stale: "stale-knowledge",
  noOwner: "collections-without-owner",
} as const;

const REPROCESS_VERBS: BulkVerbs = { running: "Reprocessing", done: "reprocessed" };
const SYNC_VERBS: BulkVerbs = { running: "Syncing", done: "synced" };
const NONE: ReadonlySet<string> = new Set();

/** Table links: foreground text, accent on hover. */
const tableLink = "font-medium text-foreground hover:text-accent-strong hover:underline";

// true only after hydration, so locale-dependent strings never mismatch the server HTML.
const noopSubscribe = () => () => {};
function useHydrated() {
  return React.useSyncExternalStore(noopSubscribe, () => true, () => false);
}

/** Relative time ("5m ago") with the exact local date and time in its tooltip. */
function TimeAgo({ iso }: { iso: string }) {
  const hydrated = useHydrated();
  return (
    <time dateTime={iso} title={hydrated ? fmtDateTime(iso) : undefined} suppressHydrationWarning>
      {relTime(iso, { never: "—", absolute: hydrated })}
    </time>
  );
}

/** A row's outcome (an error, or a note such as "Re-synced"). */
interface RowMsg {
  tone: "success" | "warning" | "danger";
  text: string;
}

/** fetch rejects with a TypeError when the request never reached the server. */
const errorText = (e: unknown, fallback: string) =>
  e instanceof TypeError ? "Network error — please try again." : bulkErrorMessage(e, fallback);

/** A message map keyed by id; `null` clears the entry. */
function useRowMessages() {
  const [msgs, setMsgs] = React.useState<Record<string, RowMsg>>({});
  const set = React.useCallback((id: string, msg: RowMsg | null) => {
    setMsgs((prev) => {
      if (!msg && !(id in prev)) return prev;
      const next = { ...prev };
      if (msg) next[id] = msg;
      else delete next[id];
      return next;
    });
  }, []);
  return [msgs, set] as const;
}

/**
 * router.refresh() once everything this page started has settled, instead of
 * once per item: reprocessing 25 documents re-renders the server page a single
 * time, and nothing on the page waits for that refresh.
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

export function DataQualityClient({ data }: { data: DataQuality }) {
  const idle = useIdleRefresh();
  const { confirm, dialog } = useConfirm();
  const dataRef = React.useRef(data);
  React.useEffect(() => {
    dataRef.current = data;
  }, [data]);

  // --- Not searchable: reprocess one or many (two at a time) ------------------
  const docPending = usePendingIds();
  const reprocessRun = useBulkRun();
  const [docMsg, setDocMsg] = useRowMessages();
  // Documents that became searchable, hidden until the server list catches up.
  const [fixedState, setFixedState] = React.useState<{ base: DataQuality; ids: ReadonlySet<string> }>(() => ({
    base: data,
    ids: NONE,
  }));
  const fixed = fixedState.base === data ? fixedState.ids : NONE;
  const markFixed = React.useCallback((id: string) => {
    setFixedState((prev) => {
      const base = dataRef.current;
      const ids = new Set(prev.base === base ? prev.ids : NONE);
      ids.add(id);
      return { base, ids };
    });
  }, []);

  const visibleDocs = data.unsearchable.filter((d) => !fixed.has(d.id));
  const fixedShown = data.unsearchable.length - visibleDocs.length;
  const counts = { ...data.counts, unsearchable: Math.max(0, data.counts.unsearchable - fixedShown) };

  // --- Failed runs: re-sync their sources (one at a time) -----------------------
  const srcPending = usePendingIds();
  const syncRun = useBulkRun();
  const [srcMsg, setSrcMsg] = useRowMessages();

  // --- Selection: one list at a time, so the page has a single bulk bar ------
  const docSel = useSelection(visibleDocs.map((d) => d.id));
  const runSel = useSelection(data.failedRuns.filter((r) => r.dataSourceId).map((r) => r.id));
  const docSelect = exclusive(docSel.selectAllProps, docSel.rowProps, runSel.clear);
  const runSelect = exclusive(runSel.selectAllProps, runSel.rowProps, docSel.clear);

  const allClear =
    counts.stale === 0 &&
    counts.unsearchable === 0 &&
    counts.reviewDue === 0 &&
    counts.noOwner === 0 &&
    counts.failedRuns === 0;

  /** Reprocess one document. Throws (with the row's message) so a bulk run counts it. */
  const reprocessDoc = React.useCallback(
    (id: string) =>
      idle.track(async () => {
        setDocMsg(id, null);
        let chunks: number;
        try {
          // No abort signal: the rebuild keeps running server-side anyway.
          const r = await requestJson<{ chunks?: number } | null>(
            `/api/admin/documents/${encodeURIComponent(id)}/reingest`,
            { method: "POST" }
          );
          chunks = Number(r?.chunks ?? 0);
        } catch (e) {
          const text =
            e instanceof HttpError && e.status === 422
              ? "Not reprocessable: the original text wasn't kept"
              : errorText(e, "Reprocess failed");
          setDocMsg(id, { tone: "danger", text });
          throw new Error(text);
        }
        if (!(chunks > 0)) {
          const text = "Reprocessed, but it produced no searchable chunks";
          setDocMsg(id, { tone: "warning", text });
          throw new Error(text);
        }
        markFixed(id); // searchable now: drop it from the list
      }),
    [idle, markFixed, setDocMsg]
  );

  function reprocessOne(id: string) {
    // The row shows the error; nothing else on the page waits for it.
    void docPending.run(id, () => reprocessDoc(id)).catch(() => {});
  }

  async function reprocessMany(ids: string[]) {
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
    await reprocessRun.run(
      ids,
      async (id) => {
        let ran = false;
        await docPending.run(id, () => {
          ran = true;
          return reprocessDoc(id);
        });
        if (!ran) throw new Error("Already reprocessing");
      },
      {
        concurrency: BULK_CONCURRENCY.reingest,
        verbs: REPROCESS_VERBS,
        // Reprocessed rows leave the list (and the selection); failed ones stay selected.
        onSettled: () => idle.request(),
      }
    );
  }

  /** Sync one source again. Throws (with the row's message) so a bulk run counts it. */
  const syncSource = React.useCallback(
    (sourceId: string) =>
      idle.track(async () => {
        setSrcMsg(sourceId, null);
        try {
          // No abort signal: the pull keeps running server-side anyway.
          const r = await requestJson<{ status?: string; error?: string } | null>(
            `/api/admin/sources/${encodeURIComponent(sourceId)}/sync`,
            { method: "POST" }
          );
          if (r?.status === "error") throw new Error(r.error || "Sync failed");
        } catch (e) {
          const text = errorText(e, "Sync failed");
          setSrcMsg(sourceId, { tone: "danger", text });
          throw new Error(text);
        }
        setSrcMsg(sourceId, { tone: "success", text: "Re-synced" });
      }),
    [idle, setSrcMsg]
  );

  async function retrySyncs(runIds: string[]) {
    const byId = new Map(dataRef.current.failedRuns.map((r) => [r.id, r]));
    const sources = Array.from(
      new Set(runIds.map((id) => byId.get(id)?.dataSourceId).filter((s): s is string => !!s))
    );
    if (sources.length === 0) return;
    if (sources.length > 1) {
      const ok = await confirm({
        title: `Sync ${fmtInt(sources.length)} sources again?`,
        description:
          "They sync one at a time, and each can take up to 5 minutes. Keep this page open until they finish; you can cancel between syncs.",
        confirmLabel: `Sync ${fmtInt(sources.length)}`,
      });
      if (!ok) return;
    }
    await syncRun.run(
      sources,
      async (sourceId) => {
        let ran = false;
        await srcPending.run(sourceId, () => {
          ran = true;
          return syncSource(sourceId);
        });
        if (!ran) throw new Error("Already syncing");
      },
      {
        concurrency: BULK_CONCURRENCY.sync,
        verbs: SYNC_VERBS,
        onSettled: (r) => {
          // Runs whose source synced are dealt with; the rest stay selected.
          const ok = new Set(r.ok);
          runSel.select(
            dataRef.current.failedRuns.filter((f) => f.dataSourceId && ok.has(f.dataSourceId)).map((f) => f.id),
            false
          );
          idle.request();
        },
      }
    );
  }

  // Tile tone: danger/warning while there is something to fix, success when clear.
  const tileTone = (count: number, severity: "danger" | "warning"): StatTone => (count > 0 ? severity : "success");
  const anchor = (count: number, id: string) => (count > 0 ? `#${id}` : undefined);

  const openDoc = (d: QualityDoc) => (
    <Link
      href={`/dashboard/documents/${d.id}`}
      aria-label={`Open ${d.title || "untitled document"}`}
      className={buttonClass({ variant: "secondary", size: "sm" })}
    >
      Open
    </Link>
  );

  // The bar acts on whichever list holds the selection.
  const selectedSourceCount = new Set(
    data.failedRuns.filter((r) => runSel.isSelected(r.id) && r.dataSourceId).map((r) => r.dataSourceId)
  ).size;
  const scope = docSel.count > 0 ? "docs" : runSel.count > 0 ? "runs" : null;
  const barActions: BulkAction[] =
    scope === "docs"
      ? [
          {
            key: "reprocess",
            label: "Reprocess",
            icon: RefreshCw,
            tone: "primary",
            onClick: () => void reprocessMany(docSel.selectedIds),
          },
        ]
      : scope === "runs"
        ? [
            {
              key: "retry-sync",
              label: selectedSourceCount === 1 ? "Retry sync" : `Retry sync · ${fmtInt(selectedSourceCount)} sources`,
              icon: RotateCcw,
              tone: "primary",
              onClick: () => void retrySyncs(runSel.selectedIds),
              title: "Runs a new sync for each selected run's source, one at a time",
            },
          ]
        : [];

  return (
    <div className="min-w-0 space-y-5">
      {/* Summary tiles, each linking to its section below */}
      <StatGrid cols={3} className="lg:grid-cols-5">
        <StatTile
          icon={Layers}
          tone={tileTone(counts.unsearchable, "danger")}
          label="Not searchable"
          value={fmtInt(counts.unsearchable)}
          hint="Documents with no chunks"
          href={anchor(counts.unsearchable, SECTION_IDS.unsearchable)}
        />
        <StatTile
          icon={AlertTriangle}
          tone={tileTone(counts.failedRuns, "danger")}
          label="Failed runs"
          value={fmtInt(counts.failedRuns)}
          hint="Syncs that errored"
          href={anchor(counts.failedRuns, SECTION_IDS.failedRuns)}
        />
        <StatTile
          icon={CalendarClock}
          tone={tileTone(counts.reviewDue, "warning")}
          label="Review due"
          value={fmtInt(counts.reviewDue)}
          hint="Review date has passed"
          href={anchor(counts.reviewDue, SECTION_IDS.reviewDue)}
        />
        <StatTile
          icon={Clock}
          tone={tileTone(counts.stale, "warning")}
          label="Stale (90d+)"
          value={fmtInt(counts.stale)}
          hint="Not updated in 90+ days"
          href={anchor(counts.stale, SECTION_IDS.stale)}
        />
        <StatTile
          icon={UserX}
          tone={tileTone(counts.noOwner, "warning")}
          label="No owner"
          value={fmtInt(counts.noOwner)}
          hint="Collections without an owner"
          href={anchor(counts.noOwner, SECTION_IDS.noOwner)}
        />
      </StatGrid>

      {allClear ? (
        <Card className="flex items-center gap-3 p-4">
          <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-success/10 text-success">
            <CheckCircle2 size={18} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Knowledge base is in good shape.</p>
            <p className="text-[13px] text-muted-foreground">
              Everything is searchable, owned, fresh, and processing cleanly across {fmtInt(data.totalDocuments)} documents.
            </p>
          </div>
        </Card>
      ) : (
        <div className="space-y-5">
          {/* Not searchable — highest priority (reprocess) */}
          {(visibleDocs.length > 0 || counts.unsearchable > 0 || reprocessRun.state) && (
            <Section
              id={SECTION_IDS.unsearchable}
              icon={Layers}
              title="Not searchable"
              description="Documents with no embedded chunks. Reprocess them to make them retrievable."
              tone="danger"
              shown={visibleDocs.length}
              total={counts.unsearchable}
            >
              <ListToolbar
                select={visibleDocs.length > 0 ? docSelect.all : undefined}
                selectLabel="Select all documents"
                run={reprocessRun}
                actions={
                  visibleDocs.length > 1 && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void reprocessMany(visibleDocs.map((d) => d.id))}
                      disabled={reprocessRun.running}
                      title={
                        counts.unsearchable > visibleDocs.length
                          ? `Reprocesses the ${fmtInt(visibleDocs.length)} listed here`
                          : undefined
                      }
                    >
                      <RefreshCw size={14} aria-hidden />
                      Reprocess all ({fmtInt(visibleDocs.length)})
                    </Button>
                  )
                }
              />
              {visibleDocs.length === 0 ? (
                <p className="px-4 py-2.5 text-[13px] text-muted-foreground">
                  Every listed document is searchable again.
                </p>
              ) : (
                <DocList
                  docs={visibleDocs}
                  select={{ isSelected: docSel.isSelected, rowProps: docSelect.row }}
                  note={(d) => docMsg[d.id]}
                  action={(d) => {
                    const busy = docPending.isPending(d.id);
                    const queued = !busy && reprocessRun.isActive(d.id);
                    return (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => reprocessOne(d.id)}
                        loading={busy}
                        disabled={queued}
                        aria-label={`Reprocess ${d.title || "untitled document"}`}
                      >
                        {!busy && <RefreshCw size={14} aria-hidden />}
                        {busy ? "Reprocessing…" : queued ? "Queued" : "Reprocess"}
                      </Button>
                    );
                  }}
                />
              )}
            </Section>
          )}

          {/* Failed runs */}
          {data.failedRuns.length > 0 && (
            <Section
              id={SECTION_IDS.failedRuns}
              icon={AlertTriangle}
              title="Failed ingestion runs"
              description="Select runs to sync their sources again, or open a source."
              tone="danger"
              shown={data.failedRuns.length}
              total={counts.failedRuns}
            >
              <ListToolbar
                select={runSel.selectAllProps.disabled ? undefined : runSelect.all}
                selectLabel="Select all failed source runs"
                run={syncRun}
              />
              <ul>
                {data.failedRuns.map((r) => {
                  const src = r.dataSourceId;
                  const syncing = !!src && srcPending.isPending(src);
                  const queued = !!src && !syncing && syncRun.isActive(src);
                  const msg = src ? srcMsg[src] : undefined;
                  return (
                    <li
                      key={r.id}
                      className={cn(
                        "flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 first:border-t-0",
                        runSel.isSelected(r.id) && SELECTED_ROW_CLASS
                      )}
                    >
                      {src ? (
                        <RowCheckbox
                          {...runSelect.row(r.id)}
                          label={`Select failed run: ${(r.error || "Unknown error").slice(0, 80)}`}
                        />
                      ) : (
                        // Uploads have no source to re-sync; keep the rows aligned.
                        <span aria-hidden className="h-4 w-4 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-[13px] font-medium text-foreground">
                          {r.error || "Unknown error"}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {triggerLabel(r.trigger)} · <TimeAgo iso={r.startedAt} />
                        </p>
                        {msg?.tone === "danger" && !syncing && !queued && (
                          <p className="break-words text-xs text-danger-ink">Retry failed: {msg.text}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-2">
                        {syncing ? (
                          <Badge tone="accent">
                            <Loader2 size={12} className="animate-spin" aria-hidden />
                            Syncing
                          </Badge>
                        ) : queued ? (
                          <Badge tone="neutral">Queued</Badge>
                        ) : msg?.tone === "success" ? (
                          <Badge tone="success">{msg.text}</Badge>
                        ) : null}
                        {src ? (
                          <Link
                            href={`/dashboard/sources/${src}`}
                            className={buttonClass({ variant: "secondary", size: "sm", className: "shrink-0" })}
                          >
                            Open source
                            <ArrowRight size={14} aria-hidden />
                          </Link>
                        ) : (
                          <Link
                            href="/dashboard/processing"
                            className={buttonClass({ variant: "secondary", size: "sm", className: "shrink-0" })}
                          >
                            Processing runs
                          </Link>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}

          {/* Review due */}
          {data.reviewDue.length > 0 && (
            <Section
              id={SECTION_IDS.reviewDue}
              icon={CalendarClock}
              title="Review date passed"
              description="These sources are due for an owner review."
              tone="warning"
              shown={data.reviewDue.length}
              total={counts.reviewDue}
            >
              <DocList docs={data.reviewDue} action={openDoc} />
            </Section>
          )}

          {/* Stale */}
          {data.stale.length > 0 && (
            <Section
              id={SECTION_IDS.stale}
              icon={Clock}
              title="Stale knowledge"
              description="Not updated in 90+ days. Confirm it's still accurate or assign a review."
              tone="warning"
              shown={data.stale.length}
              total={counts.stale}
            >
              <DocList docs={data.stale} action={openDoc} />
            </Section>
          )}

          {/* Collections without owner */}
          {data.collectionsNoOwner.length > 0 && (
            <Section
              id={SECTION_IDS.noOwner}
              icon={UserX}
              title="Collections without an owner"
              description="Assign an owner in each collection's governance settings."
              tone="warning"
              shown={data.collectionsNoOwner.length}
              total={counts.noOwner}
              padded
            >
              <ul className="flex flex-wrap gap-2">
                {data.collectionsNoOwner.map((c) => (
                  <li key={c.id}>
                    <Link
                      href="/dashboard/collections"
                      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-[13px] text-foreground transition-colors hover:bg-surface-muted"
                    >
                      {c.name}
                      <ArrowRight size={14} aria-hidden className="text-muted-foreground" />
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}

      <BulkActionBar
        count={scope === "docs" ? docSel.count : scope === "runs" ? runSel.count : 0}
        onClear={() => {
          docSel.clear();
          runSel.clear();
        }}
        noun={scope === "runs" ? ["failed run", "failed runs"] : ["document", "documents"]}
        busy={scope === "docs" ? reprocessRun.running : scope === "runs" ? syncRun.running : false}
        actions={barActions}
      />
      {dialog}
    </div>
  );
}

/**
 * Selecting in one list clears the other, so the page's single bulk bar
 * always acts on exactly one kind of row.
 */
function exclusive(
  all: SelectAllBinding,
  row: (id: string) => RowSelectBinding,
  clearOther: () => void
): { all: SelectAllBinding; row: (id: string) => RowSelectBinding } {
  return {
    all: {
      ...all,
      onCheckedChange: (checked) => {
        if (checked) clearOther();
        all.onCheckedChange(checked);
      },
    },
    row: (id) => {
      const b = row(id);
      return {
        ...b,
        onCheckedChange: (checked, opts) => {
          if (checked) clearOther();
          b.onCheckedChange(checked, opts);
        },
      };
    },
  };
}

/** A list's header strip: select-all, list actions, and its bulk run's progress. */
function ListToolbar({
  select,
  selectLabel,
  run,
  actions,
}: {
  select?: SelectAllBinding;
  selectLabel: string;
  run: BulkRun;
  actions?: React.ReactNode;
}) {
  if (!select && !actions && !run.state) return null;
  return (
    <div className="border-b border-border">
      {(select || actions) && (
        <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 px-4 py-1.5">
          {select ? (
            <label className="flex cursor-pointer items-center gap-3 text-xs text-muted-foreground">
              <SelectAllCheckbox {...select} label={selectLabel} />
              {/* Always "Select all": it says what the box does (the bar shows the count). */}
              Select all
            </label>
          ) : (
            <span />
          )}
          {actions}
        </div>
      )}
      {run.state && (
        <div className={cn("px-4 py-2", (select || actions) && "border-t border-border")}>
          <BulkProgress
            state={run.state}
            onRetry={() => void run.retryFailed()}
            onCancel={run.cancel}
            onDismiss={run.reset}
          />
        </div>
      )}
    </div>
  );
}

function Section({
  id,
  icon,
  title,
  description,
  tone,
  shown,
  total,
  padded = false,
  children,
}: {
  id: string;
  icon: React.ComponentProps<typeof SectionCard>["icon"];
  title: string;
  description: string;
  tone: "danger" | "warning";
  shown: number;
  total: number;
  /** Pad the body (chip lists); row lists run edge to edge. */
  padded?: boolean;
  children: React.ReactNode;
}) {
  return (
    <SectionCard
      id={id}
      icon={icon}
      title={title}
      description={description}
      actions={<Badge tone={tone}>{fmtInt(total)}</Badge>}
      className="scroll-mt-4"
      bodyClassName={padded ? "p-4" : "p-0"}
    >
      {children}
      {total > shown && (
        <p
          className={
            padded
              ? "mt-3 text-xs text-muted-foreground"
              : "border-t border-border px-4 py-2.5 text-xs text-muted-foreground"
          }
        >
          Showing the first {fmtInt(shown)} of {fmtInt(total)}.
        </p>
      )}
    </SectionCard>
  );
}

function DocList({
  docs,
  action,
  select,
  note,
}: {
  docs: QualityDoc[];
  action: (d: QualityDoc) => React.ReactNode;
  /** Adds a checkbox per row. */
  select?: { isSelected: (id: string) => boolean; rowProps: (id: string) => RowSelectBinding };
  /** An outcome under the row (e.g. why a reprocess failed). */
  note?: (d: QualityDoc) => RowMsg | undefined;
}) {
  return (
    <ul>
      {docs.map((d) => {
        const msg = note?.(d);
        return (
          <li
            key={d.id}
            className={cn(
              "flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 first:border-t-0",
              select?.isSelected(d.id) && SELECTED_ROW_CLASS
            )}
          >
            {select && <RowCheckbox {...select.rowProps(d.id)} label={`Select ${d.title || "untitled document"}`} />}
            <div className="min-w-0 flex-1">
              <Link href={`/dashboard/documents/${d.id}`} className={`block truncate text-[13px] ${tableLink}`}>
                {d.title || "Untitled"}
              </Link>
              <p className="truncate text-xs text-muted-foreground">{d.reason}</p>
              {msg && (
                <p
                  className={cn(
                    "break-words text-xs",
                    msg.tone === "danger" ? "text-danger-ink" : msg.tone === "warning" ? "text-warning-ink" : "text-success-ink"
                  )}
                >
                  {msg.text}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge tone="neutral" className="hidden sm:inline-flex">
                {sourceTypeLabel(d.sourceType)}
              </Badge>
              {action(d)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
