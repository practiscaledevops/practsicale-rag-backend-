"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, PlusCircle, Filter } from "lucide-react";
import {
  INTELLIGENCE_CLASSES,
  DOMAINS,
  REALITY_BUCKETS,
  typesFor,
  domainLabel,
  typeLabel,
  humanize,
  FOUNDER_ENDORSEMENTS,
  OBJECT_STATUSES,
  type IntelligenceClass,
} from "@/lib/intelligence-taxonomy";
import {
  C,
  Chip,
  KBtn,
  KInput,
  KSelect,
  KTabs,
  KTable,
  Th,
  Td,
  Empty,
  Spinner,
  ErrorNote,
  StatBox,
  fmtDate,
  endorsementTone,
  authorityTone,
  statusTone,
  api,
} from "@/components/ui/brain-ui";

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

export function KnowledgeObjectsClient() {
  const router = useRouter();
  const [tab, setTab] = React.useState<Tab>("all");
  const [q, setQ] = React.useState("");
  const [domain, setDomain] = React.useState("");
  const [type, setType] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [endorsement, setEndorsement] = React.useState("");
  const [bucket, setBucket] = React.useState("");
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

  const counts = data?.counts.byClass ?? {};
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "all", label: "All", count: data?.total },
    ...INTELLIGENCE_CLASSES.filter((c) => c.id !== "raw_archive").map((c) => ({ id: c.id as Tab, label: c.label, count: counts[c.id] ?? 0 })),
  ];
  const typeOptions = tab === "all" ? [] : typesFor(tab, domain || undefined).map((t) => ({ value: t.id, label: t.label }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatBox label="Objects" value={data?.total ?? "—"} hint="across all classes" />
        <StatBox label="Business Reality" value={counts.business_reality ?? "—"} hint="what is true" />
        <StatBox label="Playbooks" value={counts.playbook ?? "—"} hint="what should work" tone="info" />
        <StatBox label="Org Learning" value={counts.organizational_learning ?? "—"} hint="what we learned" tone="violet" />
      </div>

      {migrationMissing && (
        <ErrorNote message="The Operating Intelligence tables are not in the database yet. Apply Brain migration 0017_operating_intelligence.sql in Supabase, then reload." />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <KTabs tabs={tabs} value={tab} onChange={(v) => { setTab(v); setType(""); setBucket(""); }} />
        <div className="ml-auto flex items-center gap-2">
          <Link href="/dashboard/knowledge/add">
            <KBtn variant="primary"><PlusCircle size={14} /> Add knowledge</KBtn>
          </Link>
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-6">
        <div className="relative md:col-span-2">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5" style={{ color: C.muted }} />
          <KInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ref, name, summary…" className="pl-8" />
        </div>
        <KSelect value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="All domains" options={DOMAINS.map((d) => ({ value: d.id, label: d.label }))} />
        <KSelect value={type} onChange={(e) => setType(e.target.value)} placeholder={tab === "all" ? "Type (pick a class)" : "All types"} options={typeOptions} disabled={tab === "all"} />
        <KSelect value={status} onChange={(e) => setStatus(e.target.value)} placeholder="Any status" options={OBJECT_STATUSES.map((s) => ({ value: s.id, label: s.label }))} />
        {tab === "business_reality" ? (
          <KSelect value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="All buckets" options={REALITY_BUCKETS.map((b) => ({ value: b.id, label: b.label }))} />
        ) : (
          <KSelect value={endorsement} onChange={(e) => setEndorsement(e.target.value)} placeholder="Any endorsement" options={FOUNDER_ENDORSEMENTS.map((e) => ({ value: e.id, label: e.label }))} />
        )}
      </div>

      <ErrorNote message={error && !migrationMissing ? error : null} />

      {loading && !data ? (
        <Spinner label="Loading knowledge objects…" />
      ) : !data || data.objects.length === 0 ? (
        <Empty
          title="No knowledge objects match"
          hint={data?.total ? "Try clearing a filter." : "Add your first Playbook or Business Reality object — the AI classifies, de-duplicates and compiles it for you."}
          action={
            <Link href="/dashboard/knowledge/add">
              <KBtn variant="primary"><PlusCircle size={14} /> Add knowledge</KBtn>
            </Link>
          }
        />
      ) : (
        <KTable
          className="max-h-[calc(100vh-24rem)]"
          head={
            <>
              <Th>Ref</Th>
              <Th>Name</Th>
              <Th>Class · Domain · Type · Subtype</Th>
              <Th>Governance</Th>
              <Th>Authority</Th>
              <Th>Status</Th>
              <Th>Updated</Th>
            </>
          }
        >
          {data.objects.map((o) => {
            const expired = o.effective_until && new Date(o.effective_until).getTime() <= Date.now();
            return (
              <tr
                key={o.id}
                className="cursor-pointer transition-colors hover:bg-white/[0.03]"
                onClick={() => router.push(`/dashboard/knowledge/${o.id}`)}
              >
                <Td className="whitespace-nowrap font-mono text-xs" title={o.id}><span style={{ color: C.green }}>{o.ref}</span></Td>
                <Td>
                  <div className="font-medium" style={{ color: C.text }}>{o.name}</div>
                  {o.summary && <div className="line-clamp-1 text-xs" style={{ color: C.muted }}>{o.summary}</div>}
                </Td>
                <Td>
                  <div className="flex flex-wrap items-center gap-1">
                    <Chip tone={o.intelligence_class === "playbook" ? "info" : o.intelligence_class === "organizational_learning" ? "violet" : "green"}>
                      {INTELLIGENCE_CLASSES.find((c) => c.id === o.intelligence_class)?.label ?? o.intelligence_class}
                    </Chip>
                    <span className="text-xs" style={{ color: C.muted }}>
                      {domainLabel(o.domain)} · {typeLabel(o.object_type)}{o.subtype ? ` · ${humanize(o.subtype)}` : ""}
                    </span>
                  </div>
                  {o.bucket && <div className="mt-0.5 text-[11px]" style={{ color: C.muted }}>{REALITY_BUCKETS.find((b) => b.id === o.bucket)?.label}</div>}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {o.founder_endorsement && <Chip tone={endorsementTone(o.founder_endorsement)}>{humanize(o.founder_endorsement)}</Chip>}
                    {o.internal_validation !== "unvalidated" && <Chip tone={o.internal_validation === "validated" ? "green" : o.internal_validation === "rejected" ? "red" : "amber"}>{humanize(o.internal_validation)}</Chip>}
                    {o.implementation_status !== "not_tested" && <Chip tone="mint">{humanize(o.implementation_status)}</Chip>}
                    {o.priority === "core" && <Chip tone="amber">Core</Chip>}
                  </div>
                </Td>
                <Td><Chip tone={authorityTone(o.authority)}>{o.authority}</Chip></Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    <Chip tone={statusTone(o.status)}>{humanize(o.status)}</Chip>
                    {expired && <Chip tone="red">Expired</Chip>}
                  </div>
                </Td>
                <Td className="whitespace-nowrap text-xs" title={o.updated_at}><span style={{ color: C.muted }}>{fmtDate(o.updated_at)}</span></Td>
              </tr>
            );
          })}
        </KTable>
      )}
      <p className="flex items-center gap-1 text-[11px]" style={{ color: C.muted }}>
        <Filter size={11} /> Metadata narrows and boosts retrieval; meaning still comes from embeddings. Governance changes take effect on the next answer.
      </p>
    </div>
  );
}
