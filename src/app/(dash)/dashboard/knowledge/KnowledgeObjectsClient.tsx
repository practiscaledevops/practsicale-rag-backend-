"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Filter, Library, PlusCircle, X } from "lucide-react";
import {
  INTELLIGENCE_CLASSES,
  DOMAINS,
  REALITY_BUCKETS,
  typesFor,
  domainLabel,
  typeLabel,
  authorityLabel,
  FOUNDER_ENDORSEMENTS,
  OBJECT_STATUSES,
  type IntelligenceClass,
} from "@/lib/intelligence-taxonomy";
import {
  Alert,
  Badge,
  Button,
  buttonClass,
  ClassBadge,
  EmptyState,
  Field,
  FilterTabs,
  SearchInput,
  Select,
  Spinner,
  Table,
  TableCard,
  TableSkeletonRows,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  type BadgeTone,
} from "@/components/ui";
import { fmtDateTime, humanize, relTime } from "@/lib/format";
import { statusTone } from "@/lib/ui-labels";

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

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const p = new URLSearchParams();
    if (tab !== "all") p.set("class", tab);
    if (q.trim()) p.set("q", q.trim());
    if (domain) p.set("domain", domain);
    if (type) p.set("type", type);
    if (status) p.set("status", status);
    if (endorsement) p.set("endorsement", endorsement);
    if (bucket && tab === "business_reality") p.set("bucket", bucket);
    try {
      const res = await fetch(`/api/admin/knowledge/objects?${p.toString()}`, { cache: "no-store" });
      const json = (await res.json()) as ListResponse;
      if (!res.ok) {
        if (json.migrationMissing) setMigrationMissing(true);
        throw new Error(json.error ?? "Failed to load");
      }
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [tab, q, domain, type, status, endorsement, bucket]);

  React.useEffect(() => {
    const t = window.setTimeout(load, q ? 250 : 0);
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

  const head = (
    <THead>
      <tr>
        <Th>Ref</Th>
        <Th>Name</Th>
        <Th>Class</Th>
        <Th>Governance</Th>
        <Th>Status</Th>
        <Th>Updated</Th>
      </tr>
    </THead>
  );

  const rows = data?.objects ?? [];

  return (
    <div className="space-y-4">
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
                <TableSkeletonRows rows={6} cols={6} />
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
                effect on the next answer.
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
                return (
                  // Mouse users can click anywhere on the row; keyboard users tab to the name link.
                  <Tr key={o.id} interactive className="cursor-pointer" onClick={() => router.push(href)}>
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
    </div>
  );
}
