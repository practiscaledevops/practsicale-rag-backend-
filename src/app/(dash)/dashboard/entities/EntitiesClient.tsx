"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Combine, Trash2, Users, X } from "lucide-react";
import { ENTITY_KINDS } from "@/lib/intelligence-taxonomy";
import {
  Alert,
  Badge,
  BulkActionBar,
  Button,
  buttonClass,
  checkboxClass,
  Dialog,
  EmptyState,
  Field,
  RowSelectCell,
  SearchInput,
  SectionCard,
  Select,
  SelectAllCell,
  Table,
  TableCard,
  TableSkeletonRows,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  useBulkRun,
  useConfirm,
  useSelection,
  SELECTED_ROW_CLASS,
} from "@/components/ui";
import { api } from "@/components/ui/brain-ui";
import { requestJson, type BulkFailure, type BulkResult } from "@/lib/bulk";
import { fmtDate, fmtInt, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Entity { id: string; kind: string; name: string; slug: string; mention_count: number; aliases: string[]; created_at: string }
interface Mention { id: string; role: string | null; value: string | null; object_id: string | null; document_id: string | null; created_at: string; object: { id: string; ref: string; name: string } | null }
interface EntityList { entities: Entity[]; counts: Record<string, number> }

interface MergeResponse { entity?: Entity; merged?: string[]; failed?: BulkFailure[] }
interface DeleteResponse { deleted?: string[]; failed?: BulkFailure[] }

const ENTITIES_API = "/api/admin/knowledge/entities";
/** Entities folded in per merge request (the server's limit). */
const MERGE_BATCH = 50;

const LINK = "rounded-sm text-accent-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const plural = (n: number, one: string, many: string) => `${fmtInt(n)} ${n === 1 ? one : many}`;

export function EntitiesClient() {
  const [kind, setKind] = React.useState("");
  const [q, setQ] = React.useState("");
  const [list, setList] = React.useState<EntityList | null>(null);
  /** The entity whose mentions the side panel shows. */
  const [detail, setDetail] = React.useState<{ entity: Entity; mentions: Mention[] } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);

  // Only the newest load may write the list (a slow response for an old filter
  // never overwrites a newer one).
  const loadSeq = React.useRef(0);
  const load = React.useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const p = new URLSearchParams();
      if (kind) p.set("kind", kind);
      if (q.trim()) p.set("q", q.trim());
      const d = await api<EntityList & { migrationMissing?: boolean }>(`${ENTITIES_API}?${p}`);
      if (seq !== loadSeq.current) return;
      setList(d);
      setError(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [kind, q]);
  React.useEffect(() => { const t = window.setTimeout(() => void load(), q ? 250 : 0); return () => window.clearTimeout(t); }, [load, q]);

  const open = React.useCallback(async (id: string) => {
    try {
      const d = await api<{ entity: Entity; mentions: Mention[] }>(`${ENTITIES_API}?id=${id}`);
      setDetail(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  // Deep link from an object page: ?id=<entityId>
  const params = useSearchParams();
  const deepLinkId = params.get("id");
  React.useEffect(() => {
    if (deepLinkId) void open(deepLinkId);
  }, [deepLinkId, open]);

  // Below lg the mentions panel sits under the list: bring it into view (and move
  // focus to it, so keyboard users don't have to tab past every row) when an entity is picked.
  React.useEffect(() => {
    const el = panelRef.current;
    if (!detail || !el) return;
    const r = el.getBoundingClientRect();
    if (r.top > window.innerHeight || r.bottom < 0) {
      el.scrollIntoView({ block: "start" });
      el.focus({ preventScroll: true });
    }
  }, [detail]);

  const filtered = Boolean(q.trim() || kind);
  const detailId = detail?.entity.id;
  const entities = React.useMemo(() => list?.entities ?? [], [list]);

  // ---------------------------------------------------------------------------
  // Selection + bulk merge / delete
  // ---------------------------------------------------------------------------

  const sel = useSelection(entities.map((e) => e.id));
  const bulk = useBulkRun();
  const { confirm, dialog } = useConfirm();
  const selectedRows = React.useMemo(() => entities.filter((e) => sel.selected.has(e.id)), [entities, sel.selected]);

  // Bulk callbacks outlive the render that started them ("Retry failed" re-runs
  // the same job), so they reach the current load and panel through refs.
  const loadRef = React.useRef(load);
  const detailIdRef = React.useRef(detailId);
  React.useEffect(() => {
    loadRef.current = load;
    detailIdRef.current = detailId;
  });

  /** Drop entities from the list (and the kind counts); optionally put the merge target's new totals in place. */
  const dropRows = React.useCallback((ids: string[], target?: Entity) => {
    const gone = new Set(ids);
    setList((l) => {
      if (!l) return l;
      const counts = { ...l.counts };
      for (const e of l.entities) if (gone.has(e.id)) counts[e.kind] = Math.max(0, (counts[e.kind] ?? 0) - 1);
      const kept = l.entities.filter((e) => !gone.has(e.id));
      return { counts, entities: target ? kept.map((e) => (e.id === target.id ? { ...e, ...target } : e)) : kept };
    });
    const shown = detailIdRef.current;
    if (!shown) return;
    if (target && (shown === target.id || gone.has(shown))) void open(target.id);
    else if (gone.has(shown)) setDetail(null);
  }, [open]);

  const settleSelection = sel.settle;
  /** After a run (and after each Retry failed): keep what did not finish selected, then refresh quietly. */
  const settle = React.useCallback(
    (result: BulkResult<string>) => {
      settleSelection(result);
      void loadRef.current();
    },
    [settleSelection]
  );

  // Merge dialog: a snapshot of the selection, and the entity to keep.
  const [merge, setMerge] = React.useState<{ rows: Entity[]; targetId: string } | null>(null);

  function openMerge() {
    if (selectedRows.length < 2) return;
    // Default to the most-mentioned entity (the list is sorted that way, so the first).
    const best = selectedRows.reduce((a, b) => (b.mention_count > a.mention_count ? b : a), selectedRows[0]);
    setMerge({ rows: selectedRows, targetId: best.id });
  }

  function startMerge() {
    if (!merge) return;
    const target = merge.rows.find((e) => e.id === merge.targetId);
    const ids = merge.rows.map((e) => e.id).filter((id) => id !== merge.targetId);
    setMerge(null);
    if (!target || ids.length === 0) return;
    void bulk.runChunks(
      ids,
      async (batch, signal) => {
        const r = await requestJson<MergeResponse>(ENTITIES_API, {
          method: "POST",
          json: { action: "merge", ids: batch, targetId: target.id },
          signal,
        });
        dropRows(r?.merged ?? [], r?.entity);
        return { ok: r?.merged ?? [], failed: r?.failed ?? [] };
      },
      {
        size: MERGE_BATCH,
        verbs: { running: "Merging", done: `merged into ${target.name}` },
        onSettled: (result) => {
          settle(result);
          // The kept entity was not part of the run: untick it once the merge is complete.
          if (result.failed.length === 0 && result.skipped.length === 0) sel.select([target.id], false);
        },
      }
    );
  }

  async function deleteSelected() {
    const ids = sel.selectedIds;
    if (ids.length === 0) return;
    const names = selectedRows.slice(0, 3).map((e) => `“${e.name}”`);
    const more = ids.length - names.length;
    const mentions = selectedRows.reduce((n, e) => n + (e.mention_count ?? 0), 0);
    const ok = await confirm({
      title: `Delete ${plural(ids.length, "entity", "entities")}?`,
      description: `${names.join(", ")}${more > 0 ? ` and ${fmtInt(more)} more` : ""}. Their mentions go with them (${plural(mentions, "mention", "mentions")}); knowledge objects, documents and metrics stay. This can't be undone.`,
      tone: "danger",
      confirmLabel: `Delete ${fmtInt(ids.length)}`,
    });
    if (!ok) return;
    void bulk.runChunks(
      ids,
      async (batch, signal) => {
        const r = await requestJson<DeleteResponse>(ENTITIES_API, { method: "DELETE", json: { ids: batch }, signal });
        dropRows(r?.deleted ?? []);
        return { ok: r?.deleted ?? [], failed: r?.failed ?? [] };
      },
      { verbs: { running: "Deleting", done: "deleted" }, onSettled: settle }
    );
  }

  const mergeTarget = merge?.rows.find((e) => e.id === merge.targetId);
  const mixedKinds = merge ? new Set(merge.rows.map((e) => e.kind)).size > 1 : false;

  const head = (
    <THead>
      <tr>
        <SelectAllCell {...sel.selectAllProps} label="Select all entities shown" />
        <Th>Kind</Th>
        <Th>Name</Th>
        <Th numeric>Mentions</Th>
        <Th>First seen</Th>
      </tr>
    </THead>
  );

  return (
    // grid-cols-1 below lg: the single track is minmax(0, 1fr), so a wide table
    // scrolls inside its card instead of widening the page.
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <SearchInput
            aria-label="Search entities"
            placeholder="Search entities…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            wrapperClassName="w-full sm:w-64"
          />
          <Field label="Kind" className="w-full sm:w-44">
            <Select
              density="compact"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              placeholder="All kinds"
              options={ENTITY_KINDS.map((k) => ({ value: k, label: `${humanize(k)}${list?.counts[k] ? ` (${list.counts[k]})` : ""}` }))}
            />
          </Field>
          {filtered && (
            <Button variant="ghost" size="toolbar" onClick={() => { setQ(""); setKind(""); }}>
              <X size={14} aria-hidden />
              Clear filters
            </Button>
          )}
        </div>
        {error && (
          <Alert tone="danger" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}
        {!list ? (
          !error && (
            <TableCard>
              <Table caption="Entities (loading)">
                {head}
                <TBody>
                  <TableSkeletonRows rows={6} cols={5} />
                </TBody>
              </Table>
            </TableCard>
          )
        ) : list.entities.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={Users}
              title="No entities match"
              description="Try another search or kind."
              action={
                <Button variant="secondary" size="toolbar" onClick={() => { setQ(""); setKind(""); }}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Users}
              title="No entities yet"
              description="Entities are extracted when knowledge is compiled: people, departments, clients, offers, campaigns, platforms, frameworks, KPIs."
              action={
                <Link href="/dashboard/sources" className={buttonClass({ variant: "secondary", size: "toolbar" })}>
                  View sources
                </Link>
              }
            />
          )
        ) : (
          <TableCard>
            <Table caption="Entities" minWidth={520}>
              {head}
              <TBody>
                {list.entities.map((e) => {
                  const isOpen = detailId === e.id;
                  const isSelected = sel.isSelected(e.id);
                  const working = bulk.isActive(e.id);
                  return (
                    // Mouse users can click anywhere on the row; keyboard users use the name button.
                    // The checkbox cell stops its clicks, so ticking a row never opens it.
                    <Tr
                      key={e.id}
                      interactive
                      aria-busy={working || undefined}
                      onClick={() => open(e.id)}
                      className={cn(
                        "cursor-pointer",
                        isSelected && SELECTED_ROW_CLASS,
                        // The open row keeps an inset bar, so it stays distinct from selected rows.
                        isOpen && "bg-accent-soft shadow-[inset_3px_0_0_rgb(var(--accent))] hover:bg-accent-soft",
                        working && "opacity-60"
                      )}
                    >
                      <RowSelectCell {...sel.rowProps(e.id)} label={`Select ${e.name} (${humanize(e.kind)})`} />
                      <Td>
                        <Badge tone="neutral">{humanize(e.kind)}</Badge>
                      </Td>
                      <Td>
                        <button
                          type="button"
                          aria-current={isOpen ? "true" : undefined}
                          aria-controls="entity-mentions"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            void open(e.id);
                          }}
                          className="rounded-sm text-left font-medium text-foreground hover:text-accent-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {e.name}
                        </button>
                        {e.aliases.length > 0 && <span className="ml-1 text-xs text-muted-foreground">({e.aliases.join(", ")})</span>}
                      </Td>
                      <Td numeric>{e.mention_count}</Td>
                      <Td className="whitespace-nowrap text-xs text-muted-foreground">{fmtDate(e.created_at)}</Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          </TableCard>
        )}

        {/* After the TableCard (which clips), so the bar can stick to the bottom of the page. */}
        <BulkActionBar
          count={sel.count}
          onClear={sel.clear}
          run={bulk}
          noun={["entity", "entities"]}
          label="Bulk actions for entities"
          actions={[
            {
              key: "merge",
              label: "Merge…",
              icon: Combine,
              onClick: openMerge,
              disabled: sel.count < 2,
              title: sel.count < 2 ? "Select two or more entities to merge" : "Fold the selected entities into one",
            },
            {
              key: "delete",
              label: "Delete",
              icon: Trash2,
              tone: "danger",
              onClick: () => void deleteSelected(),
            },
          ]}
        />
      </div>

      <div
        ref={panelRef}
        id="entity-mentions"
        tabIndex={-1}
        role="region"
        aria-label="Mentions"
        className="min-w-0 scroll-mt-4 focus:outline-none lg:sticky lg:top-4 lg:self-start"
      >
        <p className="sr-only" role="status">
          {detail
            ? `${detail.entity.name}: ${detail.mentions.length} ${detail.mentions.length === 1 ? "mention" : "mentions"}`
            : ""}
        </p>
        <SectionCard
          title={detail ? `${humanize(detail.entity.kind)}: ${detail.entity.name}` : "Mentions"}
          description={
            detail
              ? `${detail.mentions.length} ${detail.mentions.length === 1 ? "mention" : "mentions"}`
              : "Select an entity to see where it appears."
          }
        >
          {!detail ? (
            <p className="text-[13px] text-muted-foreground">No entity selected.</p>
          ) : detail.mentions.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No mentions recorded.</p>
          ) : (
            <ul className="space-y-1.5 text-[13px] lg:max-h-[60vh] lg:overflow-y-auto">
              {detail.mentions.map((m) => (
                <li key={m.id} className="rounded-xl border border-border px-3 py-2 text-foreground">
                  {m.object ? (
                    <Link href={`/dashboard/knowledge/${m.object.id}`} className={LINK}>
                      <span className="font-mono text-xs">{m.object.ref}</span> {m.object.name}
                    </Link>
                  ) : m.document_id ? (
                    <Link href={`/dashboard/documents/${m.document_id}`} className={LINK}>
                      Document
                    </Link>
                  ) : (
                    "—"
                  )}
                  {(m.role || m.value) && (
                    <div className="mt-0.5 text-xs text-muted-foreground">{[m.role, m.value].filter(Boolean).join(": ")}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <Dialog
        open={merge !== null}
        onClose={() => setMerge(null)}
        title={merge ? `Merge ${plural(merge.rows.length, "entity", "entities")}` : "Merge entities"}
        description="Pick the entity to keep. The others' mentions and metrics move onto it, their names become its aliases, and then they are deleted."
        footer={
          <>
            <Button variant="secondary" size="toolbar" onClick={() => setMerge(null)}>
              Cancel
            </Button>
            <Button size="toolbar" onClick={startMerge} disabled={!mergeTarget} className="max-w-full">
              <Combine size={14} aria-hidden className="shrink-0" />
              <span className="min-w-0 truncate">{mergeTarget ? `Merge into ${mergeTarget.name}` : "Merge"}</span>
            </Button>
          </>
        }
      >
        {merge && (
          <fieldset className="min-w-0">
            <legend className="sr-only">Entity to keep</legend>
            {mixedKinds && (
              <Alert tone="warning" className="mb-3">
                These entities have different kinds. The one you keep keeps its kind.
              </Alert>
            )}
            <ul className="max-h-[50vh] space-y-1.5 overflow-y-auto">
              {merge.rows.map((e) => {
                const checked = merge.targetId === e.id;
                return (
                  <li key={e.id}>
                    <label
                      className={cn(
                        "flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-[13px] transition-colors",
                        checked ? "border-accent/40 bg-accent-softer" : "border-border hover:bg-surface-muted"
                      )}
                    >
                      <input
                        type="radio"
                        name="merge-target"
                        value={e.id}
                        checked={checked}
                        onChange={() => setMerge((m) => (m ? { ...m, targetId: e.id } : m))}
                        className={checkboxClass}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-foreground">{e.name}</span>
                        {e.aliases.length > 0 && (
                          <span className="block truncate text-xs text-muted-foreground">{e.aliases.join(", ")}</span>
                        )}
                      </span>
                      <Badge tone="neutral">{humanize(e.kind)}</Badge>
                      <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                        {plural(e.mention_count, "mention", "mentions")}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}
      </Dialog>

      {dialog}
    </div>
  );
}
