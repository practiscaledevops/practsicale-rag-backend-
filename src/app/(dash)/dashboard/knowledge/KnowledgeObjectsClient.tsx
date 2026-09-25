"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Archive, ArchiveRestore, CalendarCheck, ChevronDown, Filter, Library, PlusCircle, Trash2, X } from "lucide-react";
import {
  INTELLIGENCE_CLASSES,
  DOMAINS,
  REALITY_BUCKETS,
  typesFor,
  domainLabel,
  typeLabel,
  authorityLabel,
  FOUNDER_ENDORSEMENTS,
  IMPLEMENTATION_STATUSES,
  INTERNAL_VALIDATIONS,
  OBJECT_STATUSES,
  PRIORITIES,
  type IntelligenceClass,
} from "@/lib/intelligence-taxonomy";
import {
  Alert,
  Badge,
  BulkActionBar,
  Button,
  buttonClass,
  ClassBadge,
  EmptyState,
  Field,
  FilterTabs,
  Menu,
  RowSelectCell,
  SearchInput,
  Select,
  SelectAllCell,
  Spinner,
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
  type BadgeTone,
  type MenuItem,
} from "@/components/ui";
import { requestJson, type BulkFailure, type BulkResult, type BulkVerbs } from "@/lib/bulk";
import { fmtDateTime, fmtInt, humanize, relTime } from "@/lib/format";
import { statusTone } from "@/lib/ui-labels";
import { cn } from "@/lib/utils";

interface ObjectRow {
  id: string;
  ref: string;
  name: string;
  intelligence_class: IntelligenceClass;
  domain: string;
  object_type: string;
  subtype: string | null;
  status: string;
  priority: string;
  founder_endorsement: string | null;
  implementation_status: string;
  internal_validation: string;
  authority: string;
  tags: string[];
  summary: string | null;
  effective_until: string | null;
  updated_at: string;
  bucket: string | null;
}

interface ListResponse {
  objects: ObjectRow[];
  counts: { byClass: Record<string, number>; byStatus: Record<string, number> };
  total: number;
  migrationMissing?: boolean;
  error?: string;
}

type Tab = "all" | IntelligenceClass;

/** The list API returns at most this many objects (its default `limit`), newest first. */
const LIST_CAP = 300;

const OBJECTS_API = "/api/admin/knowledge/objects";

/** Governance fields the bulk PATCH accepts (never names, taxonomy or markdown). */
interface GovernancePatch {
  status?: string;
  priority?: string;
  founder_endorsement?: string | null;
  implementation_status?: string;
  internal_validation?: string;
  verify_now?: true;
}

/** The fields a bulk PATCH hands back per object (authority is recomputed server-side). */
type ObjectUpdate = Partial<ObjectRow> & { id: string };

interface BulkPatchResponse {
  updated?: string[];
  objects?: ObjectUpdate[];
  failed?: BulkFailure[];
  remaining?: string[];
}

interface BulkDeleteResponse {
  deleted?: string[];
  failed?: BulkFailure[];
}

/**
 * Governance chips in the list, so admins can scan for rejected or in-test
 * knowledge: founder endorsement (every value), internal validation (unless
 * unvalidated) and implementation status (unless not tested).
 */
const TRUST: Record<string, { label: string; tone: BadgeTone }> = {
  practiscale_standard: { label: "Standard", tone: "accent" },
  approved: { label: "Approved", tone: "success" },
  interested: { label: "Interested", tone: "neutral" },
};
const VALIDATION: Record<string, { label: string; tone: BadgeTone }> = {
  validated: { label: "Validated", tone: "success" },
  modified: { label: "Modified", tone: "warning" },
  rejected: { label: "Rejected", tone: "danger" },
};

const TABLE_LINK =
  "rounded-sm font-medium text-foreground hover:text-accent-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const FILTER_FIELD = "w-full sm:w-44";

/** A bulk-bar menu trigger styled as a 32px secondary toolbar button. */
const BAR_MENU_TRIGGER = buttonClass({ variant: "secondary", size: "toolbar", className: "w-auto" });

const plural = (n: number, one: string, many: string) => `${fmtInt(n)} ${n === 1 ? one : many}`;

/** The value every row shares for `field`, or undefined when they differ (or none are given). */
function commonValue(rows: ObjectRow[], field: keyof ObjectRow): unknown {
  if (rows.length === 0) return undefined;
  const first = rows[0][field];
  return rows.every((r) => r[field] === first) ? first : undefined;
}

export function KnowledgeObjectsClient() {
  const router = useRouter();
  // Deep-linkable: /dashboard/knowledge?class=playbook&domain=management&type=framework
  // (the Brain overview and other pages link straight into a filtered view).
  const params = useSearchParams();
  const initialClass = params.get("class");
  const [tab, setTab] = React.useState<Tab>(
    initialClass && INTELLIGENCE_CLASSES.some((c) => c.id === initialClass) ? (initialClass as Tab) : "all"
  );
  const [q, setQ] = React.useState(params.get("q") ?? "");
  const [domain, setDomain] = React.useState(params.get("domain") ?? "");
  const [type, setType] = React.useState(params.get("type") ?? "");
  const [status, setStatus] = React.useState(params.get("status") ?? "");
  const [endorsement, setEndorsement] = React.useState(params.get("endorsement") ?? "");
  const [bucket, setBucket] = React.useState(params.get("bucket") ?? "");
  const [data, setData] = React.useState<ListResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [migrationMissing, setMigrationMissing] = React.useState(false);

  // Only the newest load may write the list: a slow response for an old filter
  // (or a background refresh) never overwrites a newer one.
  const loadSeq = React.useRef(0);

  const load = React.useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent === true;
      const seq = ++loadSeq.current;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      const p = new URLSearchParams();
      if (tab !== "all") p.set("class", tab);
      if (q.trim()) p.set("q", q.trim());
      if (domain) p.set("domain", domain);
      if (type) p.set("type", type);
      if (status) p.set("status", status);
      if (endorsement) p.set("endorsement", endorsement);
      if (bucket && tab === "business_reality") p.set("bucket", bucket);
      try {
        const res = await fetch(`${OBJECTS_API}?${p.toString()}`, { cache: "no-store" });
        const json = (await res.json()) as ListResponse;
        if (seq !== loadSeq.current) return;
        if (!res.ok) {
          if (json.migrationMissing) setMigrationMissing(true);
          throw new Error(json.error ?? "Failed to load");
        }
        setData(json);
        setError(null);
      } catch (e) {
        if (seq !== loadSeq.current) return;
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [tab, q, domain, type, status, endorsement, bucket]
  );

  // Bulk callbacks outlive the render that started them ("Retry failed" re-runs
  // the same job), so they reach the current load and filters through refs.
  const loadRef = React.useRef(load);
  const filtersRef = React.useRef({ status, endorsement });
  React.useEffect(() => {
    loadRef.current = load;
    filtersRef.current = { status, endorsement };
  });

  React.useEffect(() => {
    const t = window.setTimeout(() => void load(), q ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [load, q]);

  // Keep the URL in step with the filters (same parameter names the page reads
  // on load), so a filtered view can be shared or reloaded. history.replaceState
  // updates useSearchParams without a server round trip; debounced for typing.
  React.useEffect(() => {
    const t = window.setTimeout(() => {
      const next = new URLSearchParams(window.location.search);
      const put = (k: string, v: string) => (v ? next.set(k, v) : next.delete(k));
      put("class", tab === "all" ? "" : tab);
      put("q", q.trim());
      put("domain", domain);
      put("type", type);
      put("status", status);
      put("endorsement", endorsement);
      put("bucket", tab === "business_reality" ? bucket : "");
      const qs = next.toString();
      const target = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (target !== current) window.history.replaceState(null, "", target);
    }, 300);
    return () => window.clearTimeout(t);
  }, [tab, q, domain, type, status, endorsement, bucket]);

  const filtersActive = Boolean(q.trim() || domain || type || status || endorsement || bucket);
  function clearFilters() {
    setQ("");
    setDomain("");
    setType("");
    setStatus("");
    setEndorsement("");
    setBucket("");
  }

  const counts = data?.counts.byClass ?? {};
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "all", label: "All", count: data?.total },
    ...INTELLIGENCE_CLASSES.filter((c) => c.id !== "raw_archive").map((c) => ({
      id: c.id as Tab,
      label: c.label,
      count: data ? counts[c.id] ?? 0 : undefined,
    })),
  ];
  const typeOptions = tab === "all" ? [] : typesFor(tab, domain || undefined).map((t) => ({ value: t.id, label: t.label }));

  const rows = React.useMemo(() => data?.objects ?? [], [data]);

  // ---------------------------------------------------------------------------
  // Selection + bulk governance
  // ---------------------------------------------------------------------------

  const sel = useSelection(rows.map((o) => o.id));
  const bulk = useBulkRun();
  const { confirm, dialog } = useConfirm();
  const selectedRows = React.useMemo(() => rows.filter((o) => sel.selected.has(o.id)), [rows, sel.selected]);

  /** Merge the server's new governance fields into the rows; rows that left the filter drop out. */
  const applyUpdates = React.useCallback((updates: ObjectUpdate[]) => {
    if (updates.length === 0) return;
    const byId = new Map(updates.map((u) => [u.id, u]));
    const f = filtersRef.current;
    setData((d) => {
      if (!d) return d;
      const objects = d.objects.flatMap((o) => {
        const u = byId.get(o.id);
        if (!u) return [o];
        const next: ObjectRow = { ...o, ...u };
        if (f.status && next.status !== f.status) return [];
        if (f.endorsement && next.founder_endorsement !== f.endorsement) return [];
        return [next];
      });
      return { ...d, objects };
    });
  }, []);

  /** Remove deleted rows and take them off the tab counts. */
  const dropRows = React.useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const gone = new Set(ids);
    setData((d) => {
      if (!d) return d;
      const removed = d.objects.filter((o) => gone.has(o.id));
      if (removed.length === 0) return d;
      const byClass = { ...d.counts.byClass };
      for (const o of removed) byClass[o.intelligence_class] = Math.max(0, (byClass[o.intelligence_class] ?? 0) - 1);
      return {
        ...d,
        objects: d.objects.filter((o) => !gone.has(o.id)),
        counts: { ...d.counts, byClass },
        total: Math.max(0, d.total - removed.length),
      };
    });
  }, []);

  const settleSelection = sel.settle;
  /** After a run (and after each Retry failed): keep what did not finish selected, then refresh quietly. */
  const settle = React.useCallback(
    (result: BulkResult<string>) => {
      settleSelection(result);
      void loadRef.current({ silent: true });
    },
    [settleSelection]
  );

  /** Patch `ids` (default: the whole selection) through the bulk PATCH. */
  function runPatch(patch: GovernancePatch, verbs: BulkVerbs, ids: string[] = sel.selectedIds) {
    if (ids.length === 0) return;
    void bulk.runChunks(
      ids,
      async (batch, signal) => {
        const r = await requestJson<BulkPatchResponse>(OBJECTS_API, { method: "PATCH", json: { ids: batch, patch }, signal });
        applyUpdates(r?.objects ?? []);
        return { ok: r?.updated ?? [], failed: r?.failed ?? [], remaining: r?.remaining ?? [] };
      },
      { verbs, onSettled: settle }
    );
  }

  async function deleteSelected() {
    const ids = sel.selectedIds;
    if (ids.length === 0) return;
    const names = selectedRows.slice(0, 3).map((o) => `“${o.name}”`);
    const more = ids.length - names.length;
    const ok = await confirm({
      title: `Delete ${plural(ids.length, "knowledge object", "knowledge objects")}?`,
      description: `${names.join(", ")}${more > 0 ? ` and ${fmtInt(more)} more` : ""}. Each object goes with its compiled and raw documents and their chunks, its relationships, entity mentions and learning record. This can't be undone.`,
      tone: "danger",
      confirmLabel: `Delete ${fmtInt(ids.length)}`,
    });
    if (!ok) return;
    void bulk.runChunks(
      ids,
      async (batch, signal) => {
        const r = await requestJson<BulkDeleteResponse>(OBJECTS_API, { method: "DELETE", json: { ids: batch }, signal });
        dropRows(r?.deleted ?? []);
        return { ok: r?.deleted ?? [], failed: r?.failed ?? [] };
      },
      { verbs: { running: "Deleting", done: "deleted" }, onSettled: settle }
    );
  }

  const barDisabled = bulk.running;
  const commonStatus = commonValue(selectedRows, "status");
  const commonEndorsement = commonValue(selectedRows, "founder_endorsement");
  const commonValidation = commonValue(selectedRows, "internal_validation");
  const commonPriority = commonValue(selectedRows, "priority");
  const commonImplementation = commonValue(selectedRows, "implementation_status");
  const radio = (common: unknown, value: unknown) => (common === undefined ? undefined : common === value);
  // Archive / Restore act only on the rows whose state they change: Restore
  // must never turn a selected draft or historical object Active.
  const archivedIds = selectedRows.filter((o) => o.status === "archived").map((o) => o.id);
  const unarchivedIds = selectedRows.filter((o) => o.status !== "archived").map((o) => o.id);
  const anyArchived = archivedIds.length > 0;
  const anyNotArchived = unarchivedIds.length > 0;
  const mixedArchive = anyArchived && anyNotArchived;
  const selectedLabel = plural(sel.count, "selected object", "selected objects");

  const statusItems: MenuItem[] = OBJECT_STATUSES.map((s) => ({
    label: s.label,
    active: radio(commonStatus, s.id),
    onSelect: () => runPatch({ status: s.id }, { running: "Updating", done: `set to ${s.label.toLowerCase()}` }),
  }));
  const endorsementItems: MenuItem[] = [
    ...FOUNDER_ENDORSEMENTS.map((e) => ({
      label: e.label,
      active: radio(commonEndorsement, e.id),
      onSelect: () => runPatch({ founder_endorsement: e.id }, { running: "Endorsing", done: `endorsed as ${e.label}` }),
    })),
    {
      label: "Clear endorsement",
      separatorBefore: true,
      onSelect: () => runPatch({ founder_endorsement: null }, { running: "Updating", done: "unendorsed" }),
    },
  ];
  const validationItems: MenuItem[] = INTERNAL_VALIDATIONS.map((v) => ({
    label: v.label,
    active: radio(commonValidation, v.id),
    onSelect: () => runPatch({ internal_validation: v.id }, { running: "Updating", done: `marked ${v.label.toLowerCase()}` }),
  }));
  const moreItems: MenuItem[] = [
    ...PRIORITIES.map((p) => ({
      label: `Priority: ${p.label}`,
      active: radio(commonPriority, p.id),
      onSelect: () => runPatch({ priority: p.id }, { running: "Updating", done: `set to ${p.label.toLowerCase()} priority` }),
    })),
    ...IMPLEMENTATION_STATUSES.map((s, i) => ({
      label: `Implementation: ${s.label}`,
      active: radio(commonImplementation, s.id),
      separatorBefore: i === 0,
      onSelect: () => runPatch({ implementation_status: s.id }, { running: "Updating", done: `marked ${s.label.toLowerCase()}` }),
    })),
  ];

  const barMenu = (label: string, text: string, items: MenuItem[]) => (
    <Menu
      label={`${label} for ${selectedLabel}`}
      items={items}
      align="start"
      width={220}
      disabled={barDisabled}
      triggerClassName={BAR_MENU_TRIGGER}
      trigger={
        <>
          {text}
          <ChevronDown size={14} aria-hidden className="text-muted-foreground" />
        </>
      }
    />
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const head = (
    <THead>
      <tr>
        <SelectAllCell {...sel.selectAllProps} label="Select all knowledge objects shown" />
        <Th>Ref</Th>
        <Th>Name</Th>
        <Th>Class</Th>
        <Th>Governance</Th>
        <Th>Status</Th>
        <Th>Updated</Th>
      </tr>
    </THead>
  );

  return (
    <div className="min-w-0 space-y-4">
      {migrationMissing && (
        <Alert tone="info" title="Not enabled yet">
          <p>Knowledge objects aren&apos;t set up in this workspace&apos;s database yet.</p>
          <details className="mt-1">
            <summary className="cursor-pointer text-xs font-medium text-foreground">Technical details</summary>
            <p className="mt-1 text-xs">
              The Operating Intelligence tables are missing. Apply Brain migration{" "}
              <code className="font-mono">0017_operating_intelligence.sql</code> in Supabase, then reload.
            </p>
          </details>
        </Alert>
      )}

      <FilterTabs
        label="Class filter"
        value={tab}
        tabs={tabs}
        onChange={(v) => {
          setTab(v);
          setType("");
          setBucket("");
        }}
      />

      <div className="flex flex-wrap items-end gap-3">
        <SearchInput
          aria-label="Search knowledge objects"
          placeholder="Search ref, name, summary…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          wrapperClassName="w-full sm:w-64"
        />
        <Field label="Domain" className={FILTER_FIELD}>
          <Select
            density="compact"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="All domains"
            options={DOMAINS.map((d) => ({ value: d.id, label: d.label }))}
          />
        </Field>
        <Field label="Type" className={FILTER_FIELD}>
          <Select
            density="compact"
            value={type}
            onChange={(e) => setType(e.target.value)}
            placeholder={tab === "all" ? "Pick a class first" : "All types"}
            options={typeOptions}
            disabled={tab === "all"}
          />
        </Field>
        <Field label="Status" className={FILTER_FIELD}>
          <Select
            density="compact"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            placeholder="Any status"
            options={OBJECT_STATUSES.map((s) => ({ value: s.id, label: s.label }))}
          />
        </Field>
        {tab === "business_reality" ? (
          <Field label="Bucket" className={FILTER_FIELD}>
            <Select
              density="compact"
              value={bucket}
              onChange={(e) => setBucket(e.target.value)}
              placeholder="All buckets"
              options={REALITY_BUCKETS.map((b) => ({ value: b.id, label: b.label }))}
            />
          </Field>
        ) : (
          <Field label="Endorsement" className={FILTER_FIELD}>
            <Select
              density="compact"
              value={endorsement}
              onChange={(e) => setEndorsement(e.target.value)}
              placeholder="Any endorsement"
              options={FOUNDER_ENDORSEMENTS.map((x) => ({ value: x.id, label: x.label }))}
            />
          </Field>
        )}
        <div className="flex h-8 items-center gap-2">
          {filtersActive && (
            <Button variant="ghost" size="toolbar" onClick={clearFilters}>
              <X size={14} aria-hidden />
              Clear filters
            </Button>
          )}
          {loading && data && <Spinner label="Refreshing…" className="py-0 text-xs" />}
        </div>
      </div>

      {error && !migrationMissing && <Alert tone="danger">{error}</Alert>}

      {!data ? (
        loading ? (
          <TableCard>
            <Table caption="Knowledge objects (loading)">
              {head}
              <TBody>
                <TableSkeletonRows rows={6} cols={7} />
              </TBody>
            </Table>
          </TableCard>
        ) : null
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Library}
          title="No knowledge objects match"
          description={
            data.total
              ? "Try clearing a filter."
              : "Add your first Playbook or Business Reality object — the AI classifies, de-duplicates and compiles it for you."
          }
          action={
            filtersActive ? (
              <Button variant="secondary" size="toolbar" onClick={clearFilters}>
                <X size={14} aria-hidden />
                Clear filters
              </Button>
            ) : (
              <Link href="/dashboard/knowledge/add" className={buttonClass({ size: "toolbar" })}>
                <PlusCircle size={14} aria-hidden />
                Add knowledge
              </Link>
            )
          }
        />
      ) : (
        <TableCard
          title={`${rows.length.toLocaleString()} ${rows.length === 1 ? "object" : "objects"}`}
          meta={
            rows.length >= LIST_CAP
              ? "the most recently updated. Narrow the filters to reach older ones."
              : undefined
          }
          footer={
            <span className="flex items-start gap-1.5">
              <Filter size={12} aria-hidden className="mt-0.5 shrink-0" />
              <span>
                Metadata narrows and boosts retrieval; meaning still comes from embeddings. Governance changes take
                effect on the next answer. Tick rows (Shift-click for a range) to archive, re-govern or delete many at once.
              </span>
            </span>
          }
        >
          <Table caption="Knowledge objects">
            {head}
            <TBody>
              {rows.map((o) => {
                const href = `/dashboard/knowledge/${o.id}`;
                const expired = o.effective_until && new Date(o.effective_until).getTime() <= Date.now();
                const trust = o.founder_endorsement
                  ? (TRUST[o.founder_endorsement] ?? { label: humanize(o.founder_endorsement), tone: "neutral" as const })
                  : undefined;
                const validation =
                  o.internal_validation && o.internal_validation !== "unvalidated"
                    ? (VALIDATION[o.internal_validation] ?? { label: humanize(o.internal_validation), tone: "neutral" as const })
                    : undefined;
                const bucketLabel = o.bucket ? REALITY_BUCKETS.find((b) => b.id === o.bucket)?.label : undefined;
                const selected = sel.isSelected(o.id);
                const working = bulk.isActive(o.id);
                return (
                  // Mouse users can click anywhere on the row; keyboard users tab to the name link.
                  // The checkbox cell stops its clicks, so ticking a row never opens it.
                  <Tr
                    key={o.id}
                    interactive
                    aria-busy={working || undefined}
                    className={cn(
                      "cursor-pointer",
                      selected && SELECTED_ROW_CLASS,
                      working && "opacity-60"
                    )}
                    onClick={() => router.push(href)}
                  >
                    <RowSelectCell {...sel.rowProps(o.id)} label={`Select ${o.ref} ${o.name}`} />
                    <Td className="whitespace-nowrap font-mono text-xs text-muted-foreground" title={o.id}>
                      {o.ref}
                    </Td>
                    <Td className="min-w-[14rem]">
                      <Link href={href} onClick={(e) => e.stopPropagation()} className={TABLE_LINK}>
                        {o.name}
                      </Link>
                      {o.summary && <div className="line-clamp-1 text-xs text-muted-foreground">{o.summary}</div>}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <ClassBadge klass={o.intelligence_class} />
                        <span className="text-xs text-muted-foreground">
                          {domainLabel(o.domain)} · {typeLabel(o.object_type)}
                          {o.subtype ? ` · ${humanize(o.subtype)}` : ""}
                          {bucketLabel ? ` · ${bucketLabel}` : ""}
                        </span>
                      </div>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {trust && <Badge tone={trust.tone}>{trust.label}</Badge>}
                        {validation && <Badge tone={validation.tone}>{validation.label}</Badge>}
                        {o.implementation_status && o.implementation_status !== "not_tested" && (
                          <Badge tone="info">{humanize(o.implementation_status)}</Badge>
                        )}
                        {o.priority === "core" && <Badge tone="neutral">Core</Badge>}
                        <abbr
                          title={`Authority ${o.authority}: ${authorityLabel(o.authority)}`}
                          className="font-mono text-xs text-muted-foreground no-underline"
                        >
                          {o.authority}
                        </abbr>
                      </div>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={statusTone(o.status)}>{humanize(o.status)}</Badge>
                        {expired && <span className="text-xs font-medium text-warning">Expired</span>}
                      </div>
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-muted-foreground" title={fmtDateTime(o.updated_at)}>
                      {relTime(o.updated_at)}
                    </Td>
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
        noun={["object", "objects"]}
        label="Bulk actions for knowledge objects"
        actions={[
          {
            key: "delete",
            label: "Delete",
            icon: Trash2,
            tone: "danger",
            onClick: () => void deleteSelected(),
          },
        ]}
      >
        {anyNotArchived && (
          <Button
            variant="secondary"
            size="toolbar"
            disabled={barDisabled}
            onClick={() => runPatch({ status: "archived" }, { running: "Archiving", done: "archived" }, unarchivedIds)}
            title="Archive the selected objects that are not archived yet: kept for the record, trusted least (authority C3)"
          >
            <Archive size={14} aria-hidden />
            {mixedArchive ? `Archive ${fmtInt(unarchivedIds.length)}` : "Archive"}
          </Button>
        )}
        {anyArchived && (
          <Button
            variant="secondary"
            size="toolbar"
            disabled={barDisabled}
            onClick={() => runPatch({ status: "active" }, { running: "Restoring", done: "restored" }, archivedIds)}
            title="Restores the selected objects that are archived (sets them to Active)"
          >
            <ArchiveRestore size={14} aria-hidden />
            {mixedArchive ? `Restore ${fmtInt(archivedIds.length)}` : "Restore"}
          </Button>
        )}
        {barMenu("Set status", "Status", statusItems)}
        {barMenu("Set founder endorsement", "Endorsement", endorsementItems)}
        {barMenu("Set internal validation", "Validation", validationItems)}
        <Button
          variant="secondary"
          size="toolbar"
          disabled={barDisabled}
          onClick={() => runPatch({ verify_now: true }, { running: "Verifying", done: "verified" })}
          title="Stamp each object as verified today"
        >
          <CalendarCheck size={14} aria-hidden />
          Verify now
        </Button>
        {barMenu("More: priority and implementation", "More", moreItems)}
      </BulkActionBar>

      {dialog}
    </div>
  );
}
