// The "AI Brain overview": ONE org-scoped read of every component of the
// Operating Intelligence System — objects, retrieval lanes, learning lifecycle,
// the graph, taxonomy, ingestion, performance memory, retrieval activity and a
// health checklist — so the CEO can open one page and see what is inside.
//
// Every part is computed in parallel and wrapped: a missing table (migration
// 0017 / 0014 not applied yet) or a failing query nulls THAT part, never the
// page. Queries are cheap by design (head counts, one capped column select for
// the object aggregations). Server-only (service-role client); the pure
// aggregation helpers are exported for tests.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  INTELLIGENCE_CLASSES,
  AUTHORITY_LEVELS,
  FOUNDER_ENDORSEMENTS,
  IMPLEMENTATION_STATUSES,
  INTERNAL_VALIDATIONS,
  LEARNING_RECORD_TYPES,
  domainLabel,
  typeLabel,
  relationshipLabel,
  isCurrent,
  humanize,
  type IntelligenceClass,
} from "@/lib/intelligence-taxonomy";
import { modeDef } from "@/lib/work-modes";
import { loadSettings } from "@/lib/settings";
import { getProviderKey } from "@/lib/secrets";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** An object whose last verification is older than this needs a human look. */
export const STALE_DAYS = 90;
const OBJECT_ROW_CAP = 5000;
const DAY_MS = 86_400_000;

/** Prompt use-cases the Operating Intelligence pipeline reads from the Prompt Studio. */
export const REQUIRED_PROMPTS = ["intent_classify", "knowledge_classify", "knowledge_compile", "dedup_judge", "learning_detect"];

/** Learning records still in flight. */
export const OPEN_LEARNING_STATUSES = ["open", "implementing", "measuring"];

/** Company-wide metric keys written by src/lib/call-score-metrics.ts. */
const HEADLINE_METRIC_KEYS = ["avg_call_score", "close_rate", "calls_scored"];

const DEDUP_OUTCOMES = ["new", "enrich", "duplicate", "conflict"] as const;
const DOC_SOURCE_TYPES = ["document", "call_score", "transcript", "coaching"];

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface Labelled {
  id: string;
  label: string;
  count: number;
}

/** The columns the object aggregation reads (never markdown or the embedding). */
export interface ObjectRowLite {
  ref: string;
  name: string;
  intelligence_class: string;
  domain: string | null;
  object_type: string | null;
  authority: string | null;
  founder_endorsement: string | null;
  implementation_status: string | null;
  internal_validation: string | null;
  status: string | null;
  effective_from: string | null;
  effective_until: string | null;
  last_verified_at: string | null;
  updated_at: string;
}

export interface ObjectsPart {
  total: number;
  /** True when more objects exist than the aggregation sampled (cap = 5000, newest first). */
  capped: boolean;
  byClass: Record<IntelligenceClass, number>;
  byDomain: Labelled[];
  /** Top 12 object types. */
  byType: Labelled[];
  /** A1 → C3 in ladder order (0 when none). */
  authority: Labelled[];
  endorsement: { interested: number; approved: number; practiscale_standard: number; none: number };
  implementation: Record<string, number>;
  validation: Record<string, number>;
  byStatus: Record<string, number>;
  /** current = active/draft and inside its effective window; expired = outside it; historical = historical/archived. */
  currency: { current: number; expired: number; historical: number };
  /** Non-historical objects never verified or verified more than STALE_DAYS ago. */
  needsVerification: { count: number; examples: { ref: string; name: string; lastVerifiedAt: string | null }[] };
  newest: { ref: string; name: string; intelligence_class: string; updated_at: string }[];
  /** Top 3 domains per class (for the class cards). */
  topDomainsByClass: Record<string, Labelled[]>;
}

export interface LanesPart {
  chunks: { total: number; embedded: number; byClass: Record<IntelligenceClass, number> };
  documents: { total: number; bySourceType: Record<string, number> };
}

export interface LearningRowLite {
  record_type: string;
  lifecycle_status: string | null;
  missing_evidence?: string[] | null;
}

export interface LearningPart {
  total: number;
  /** Counts per record type in lifecycle order (+ postmortem). */
  funnel: Labelled[];
  byStatus: Record<string, number>;
  /** open / implementing / measuring. */
  open: number;
  /** Open records that still list missing evidence. */
  pendingFollowUps: number;
  /** AI-suggested evidence edges (evidence_for / uses_evidence) awaiting review. */
  suggestedEvidenceEdges: number;
}

export interface GraphPart {
  entities: { total: number; byKind: Labelled[] };
  relationships: { confirmed: number; suggested: number; rejected: number; byType: Labelled[] };
}

export interface TaxonomyPart {
  approved: number;
  pending: number;
  latestProposals: { kind: string; value: string; domain: string | null; objectType: string | null; createdAt: string }[];
}

export interface IngestionPart {
  decisionsLast7d: number;
  byStage: Labelled[];
  dedupLast30d: Record<(typeof DEDUP_OUTCOMES)[number], number>;
  lastDecisionAt: string | null;
}

export interface PerformancePart {
  metrics: number;
  headline: { key: string; label: string; value: number; unit: string | null; periodEnd: string | null }[];
  latestPeriod: string | null;
}

export interface QueryRowLite {
  mode: string | null;
  grounded: boolean | null;
  refused: boolean | null;
}

export interface RetrievalPart {
  days: number;
  queries: number;
  refusals: number;
  /** Share of answers judged grounded, among those with a verdict (null when none). */
  groundedRate: number | null;
  /** Top 6 work modes (experts). */
  byMode: Labelled[];
  avgLatencyMs: number | null;
  answersWithLatency: number;
}

export interface HealthRow {
  id: string;
  label: string;
  status: "ok" | "warn";
  detail: string;
  fix?: { label: string; href: string };
}

export interface HealthInput {
  migration: boolean;
  objectsTotal: number | null;
  promptsMissing: string[] | null;
  pendingTaxonomy: number | null;
  pendingRelationships: number | null;
  pendingFollowUps: number | null;
  staleObjects: number | null;
  orchestrator: boolean;
  openaiKey: boolean;
  anthropicKey: boolean;
}

export interface BrainOverview {
  generatedAt: string;
  objects: ObjectsPart | null;
  lanes: LanesPart | null;
  learning: LearningPart | null;
  graph: GraphPart | null;
  taxonomy: TaxonomyPart | null;
  ingestion: IngestionPart | null;
  performance: PerformancePart | null;
  retrieval: RetrievalPart | null;
  prompts: { published: string[]; missing: string[] } | null;
  flags: { orchestrator: boolean; autoWorkMode: boolean; relationshipExpansion: boolean; learningDetection: boolean };
  /** Presence only — never the values. */
  providers: { openai: boolean; anthropic: boolean };
  health: HealthRow[];
}

// ---------------------------------------------------------------------------
// Pure aggregation helpers (unit-tested)
// ---------------------------------------------------------------------------

function bump(m: Map<string, number>, k: string): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

function ranked(m: Map<string, number>, label: (id: string) => string, top?: number): Labelled[] {
  const out = Array.from(m.entries())
    .map(([id, count]) => ({ id, label: label(id), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return top ? out.slice(0, top) : out;
}

/** Aggregate one column-select of objects (ordered newest first) into the ObjectsPart. */
export function aggregateObjects(rows: ObjectRowLite[], opts: { total?: number; now?: Date } = {}): ObjectsPart {
  const now = opts.now ?? new Date();
  const total = opts.total ?? rows.length;
  const staleBefore = now.getTime() - STALE_DAYS * DAY_MS;

  const byClass = Object.fromEntries(INTELLIGENCE_CLASSES.map((c) => [c.id, 0])) as Record<IntelligenceClass, number>;
  const domains = new Map<string, number>();
  const types = new Map<string, number>();
  const authority = new Map<string, number>();
  const endorsement = { interested: 0, approved: 0, practiscale_standard: 0, none: 0 };
  const implementation = Object.fromEntries(IMPLEMENTATION_STATUSES.map((s) => [s.id, 0])) as Record<string, number>;
  const validation = Object.fromEntries(INTERNAL_VALIDATIONS.map((s) => [s.id, 0])) as Record<string, number>;
  const byStatus: Record<string, number> = {};
  const currency = { current: 0, expired: 0, historical: 0 };
  const stale = { count: 0, examples: [] as { ref: string; name: string; lastVerifiedAt: string | null }[] };
  const perClassDomain = new Map<string, Map<string, number>>();

  for (const r of rows) {
    const cls = r.intelligence_class;
    if (cls in byClass) byClass[cls as IntelligenceClass] += 1;
    const dom = r.domain || "other";
    bump(domains, dom);
    bump(types, r.object_type || "document");
    bump(authority, r.authority || "B3");

    const e = r.founder_endorsement;
    if (e === "interested" || e === "approved" || e === "practiscale_standard") endorsement[e] += 1;
    else endorsement.none += 1;
    const impl = r.implementation_status || "not_tested";
    implementation[impl] = (implementation[impl] ?? 0) + 1;
    const val = r.internal_validation || "unvalidated";
    validation[val] = (validation[val] ?? 0) + 1;
    const status = r.status || "active";
    byStatus[status] = (byStatus[status] ?? 0) + 1;

    const historical = status === "historical" || status === "archived";
    if (historical) currency.historical += 1;
    else if (isCurrent(r, now)) currency.current += 1;
    else currency.expired += 1;

    if (!historical) {
      const t = r.last_verified_at ? Date.parse(r.last_verified_at) : NaN;
      if (!Number.isFinite(t) || t < staleBefore) {
        stale.count += 1;
        if (stale.examples.length < 5) stale.examples.push({ ref: r.ref, name: r.name, lastVerifiedAt: r.last_verified_at ?? null });
      }
    }

    if (!perClassDomain.has(cls)) perClassDomain.set(cls, new Map());
    bump(perClassDomain.get(cls)!, dom);
  }

  const topDomainsByClass: Record<string, Labelled[]> = {};
  for (const [cls, m] of perClassDomain) topDomainsByClass[cls] = ranked(m, domainLabel, 3);

  return {
    total,
    capped: rows.length >= OBJECT_ROW_CAP && total > rows.length,
    byClass,
    byDomain: ranked(domains, domainLabel),
    byType: ranked(types, typeLabel, 12),
    authority: AUTHORITY_LEVELS.map((a) => ({ id: a.id, label: a.label, count: authority.get(a.id) ?? 0 })),
    endorsement,
    implementation,
    validation,
    byStatus,
    currency,
    needsVerification: stale,
    newest: rows.slice(0, 5).map((r) => ({ ref: r.ref, name: r.name, intelligence_class: r.intelligence_class, updated_at: r.updated_at })),
    topDomainsByClass,
  };
}

/** Counts per lifecycle stage + status, open work and follow-ups from learning_records rows. */
export function lifecycleFunnel(rows: LearningRowLite[]): Omit<LearningPart, "suggestedEvidenceEdges"> {
  const byType = new Map<string, number>();
  const byStatus: Record<string, number> = {};
  let open = 0;
  let pendingFollowUps = 0;
  for (const r of rows) {
    bump(byType, r.record_type);
    const s = r.lifecycle_status || "open";
    byStatus[s] = (byStatus[s] ?? 0) + 1;
    const isOpen = OPEN_LEARNING_STATUSES.includes(s);
    if (isOpen) open += 1;
    if (isOpen && Array.isArray(r.missing_evidence) && r.missing_evidence.length > 0) pendingFollowUps += 1;
  }
  return {
    total: rows.length,
    funnel: LEARNING_RECORD_TYPES.map((t) => ({ id: t, label: t === "standard" ? "PractiScale Standard" : humanize(t), count: byType.get(t) ?? 0 })),
    byStatus,
    open,
    pendingFollowUps,
  };
}

/** Queries → counts, refusals, grounded rate, by expert; latencies → average. */
export function summarizeQueries(rows: QueryRowLite[], latencies: number[], days = 7): RetrievalPart {
  const byMode = new Map<string, number>();
  let refusals = 0;
  let withVerdict = 0;
  let grounded = 0;
  for (const r of rows) {
    if (r.refused) refusals += 1;
    if (typeof r.grounded === "boolean") {
      withVerdict += 1;
      if (r.grounded) grounded += 1;
    }
    bump(byMode, r.mode || "auto");
  }
  const valid = latencies.filter((l) => Number.isFinite(l) && l >= 0);
  return {
    days,
    queries: rows.length,
    refusals,
    groundedRate: withVerdict ? grounded / withVerdict : null,
    byMode: ranked(byMode, (id) => modeDef(id)?.label ?? humanize(id), 6),
    avgLatencyMs: valid.length ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length) : null,
    answersWithLatency: valid.length,
  };
}

/** Green/amber rows with the fix action for every amber one. */
export function healthChecklist(i: HealthInput): HealthRow[] {
  const rows: HealthRow[] = [];
  const nz = (v: number | null) => v ?? 0;

  rows.push(
    i.migration
      ? { id: "migration", label: "Operating Intelligence tables", status: "ok", detail: "Migration 0017 is applied — knowledge objects are reachable." }
      : { id: "migration", label: "Operating Intelligence tables", status: "warn", detail: "knowledge_objects is not reachable. Apply Brain migration 0017_operating_intelligence.sql in Supabase.", fix: { label: "Read the runbook", href: "/dashboard/settings" } }
  );

  const missing = i.promptsMissing ?? REQUIRED_PROMPTS;
  rows.push(
    missing.length === 0
      ? { id: "prompts", label: "Pipeline prompts published", status: "ok", detail: "Active versions exist for every Operating Intelligence prompt." }
      : { id: "prompts", label: "Pipeline prompts published", status: "warn", detail: `Using built-in defaults for: ${missing.join(", ")}. Publish them to edit behaviour live.`, fix: { label: "Open Prompt Studio", href: "/dashboard/prompts" } }
  );

  rows.push(
    nz(i.objectsTotal) > 0
      ? { id: "objects", label: "Knowledge compiled", status: "ok", detail: `${nz(i.objectsTotal).toLocaleString()} knowledge objects are compiled and searchable.` }
      : { id: "objects", label: "Knowledge compiled", status: "warn", detail: "No knowledge objects yet — the Brain is answering from raw documents only.", fix: { label: "Add knowledge", href: "/dashboard/knowledge/add" } }
  );

  rows.push(
    nz(i.pendingTaxonomy) === 0
      ? { id: "taxonomy", label: "Taxonomy proposals", status: "ok", detail: "No AI-proposed taxonomy values are waiting for approval." }
      : { id: "taxonomy", label: "Taxonomy proposals", status: "warn", detail: `${nz(i.pendingTaxonomy)} proposed value${nz(i.pendingTaxonomy) === 1 ? "" : "s"} waiting for approval.`, fix: { label: "Review taxonomy", href: "/dashboard/taxonomy" } }
  );

  rows.push(
    nz(i.pendingRelationships) === 0
      ? { id: "relationships", label: "Relationship suggestions", status: "ok", detail: "No suggested links are waiting for review." }
      : { id: "relationships", label: "Relationship suggestions", status: "warn", detail: `${nz(i.pendingRelationships)} suggested link${nz(i.pendingRelationships) === 1 ? "" : "s"} waiting for confirmation.`, fix: { label: "Review relationships", href: "/dashboard/relationships" } }
  );

  rows.push(
    nz(i.pendingFollowUps) === 0
      ? { id: "followups", label: "Learning follow-ups", status: "ok", detail: "No open learning is missing evidence." }
      : { id: "followups", label: "Learning follow-ups", status: "warn", detail: `${nz(i.pendingFollowUps)} open learning record${nz(i.pendingFollowUps) === 1 ? "" : "s"} still need evidence or a result.`, fix: { label: "Open Learning Lab", href: "/dashboard/learning" } }
  );

  rows.push(
    nz(i.staleObjects) === 0
      ? { id: "stale", label: "Knowledge freshness", status: "ok", detail: `Every object was verified in the last ${STALE_DAYS} days.` }
      : { id: "stale", label: "Knowledge freshness", status: "warn", detail: `${nz(i.staleObjects)} object${nz(i.staleObjects) === 1 ? "" : "s"} never verified or older than ${STALE_DAYS} days.`, fix: { label: "Review objects", href: "/dashboard/knowledge" } }
  );

  rows.push(
    i.orchestrator
      ? { id: "orchestrator", label: "Retrieval orchestrator", status: "ok", detail: "Answers reason across lanes (reality → learning → standards → playbooks)." }
      : { id: "orchestrator", label: "Retrieval orchestrator", status: "warn", detail: "features.orchestrator is off — the classic single-lane pipeline is answering.", fix: { label: "Open settings", href: "/dashboard/settings" } }
  );

  rows.push(
    i.openaiKey
      ? { id: "openai", label: "OpenAI key (embeddings)", status: "ok", detail: "Configured — ingestion and search can embed text." }
      : { id: "openai", label: "OpenAI key (embeddings)", status: "warn", detail: "Missing — nothing new can be embedded or searched semantically.", fix: { label: "Set provider keys", href: "/dashboard/settings" } }
  );

  rows.push(
    i.anthropicKey
      ? { id: "anthropic", label: "Anthropic key (generation)", status: "ok", detail: "Configured — Claude is available for answers and compilation." }
      : { id: "anthropic", label: "Anthropic key (generation)", status: "warn", detail: "Missing — generation falls back to OpenAI only.", fix: { label: "Set provider keys", href: "/dashboard/settings" } }
  );

  return rows;
}

// ---------------------------------------------------------------------------
// Data access (each part wrapped: any failure → null for that part)
// ---------------------------------------------------------------------------

async function part<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

type Q = ReturnType<ReturnType<SupabaseClient["from"]>["select"]>;

/** Exact head count of an org-scoped table with optional extra filters. Throws on error. */
async function headCount(db: SupabaseClient, table: string, orgId: string, refine?: (q: Q) => Q): Promise<number> {
  let q = db.from(table).select("id", { count: "exact", head: true }).eq("org_id", orgId) as Q;
  if (refine) q = refine(q);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

async function rowsOf<T>(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as T[];
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

async function objectsPart(db: SupabaseClient, orgId: string): Promise<ObjectsPart> {
  const [total, rows] = await Promise.all([
    headCount(db, "knowledge_objects", orgId),
    rowsOf<ObjectRowLite>(
      db
        .from("knowledge_objects")
        .select("ref, name, intelligence_class, domain, object_type, authority, founder_endorsement, implementation_status, internal_validation, status, effective_from, effective_until, last_verified_at, updated_at")
        .eq("org_id", orgId)
        .order("updated_at", { ascending: false })
        .limit(OBJECT_ROW_CAP)
    ),
  ]);
  return aggregateObjects(rows, { total });
}

async function lanesPart(db: SupabaseClient, orgId: string): Promise<LanesPart> {
  const classes = INTELLIGENCE_CLASSES.map((c) => c.id);
  const [total, embedded, legacy, perClass, docTotal, perSource] = await Promise.all([
    headCount(db, "chunks", orgId),
    headCount(db, "chunks", orgId, (q) => q.not("embedding", "is", null)),
    // NULL lane = legacy rows = Business Reality (see hybrid_search_lane).
    headCount(db, "chunks", orgId, (q) => q.is("intelligence_class", null)),
    Promise.all(classes.map((c) => headCount(db, "chunks", orgId, (q) => q.eq("intelligence_class", c)))),
    headCount(db, "documents", orgId),
    Promise.all(DOC_SOURCE_TYPES.map((s) => headCount(db, "documents", orgId, (q) => q.eq("source_type", s)))),
  ]);
  const byClass = Object.fromEntries(classes.map((c, i) => [c, perClass[i]])) as Record<IntelligenceClass, number>;
  byClass.business_reality += legacy;
  return {
    chunks: { total, embedded, byClass },
    documents: { total: docTotal, bySourceType: Object.fromEntries(DOC_SOURCE_TYPES.map((s, i) => [s, perSource[i]])) },
  };
}

async function learningPart(db: SupabaseClient, orgId: string): Promise<LearningPart> {
  const [rows, suggestedEvidenceEdges] = await Promise.all([
    rowsOf<LearningRowLite>(db.from("learning_records").select("record_type, lifecycle_status, missing_evidence").eq("org_id", orgId).limit(5000)),
    part(() => headCount(db, "knowledge_relationships", orgId, (q) => q.eq("status", "suggested").in("relationship_type", ["evidence_for", "uses_evidence"]))),
  ]);
  return { ...lifecycleFunnel(rows), suggestedEvidenceEdges: suggestedEvidenceEdges ?? 0 };
}

async function graphPart(db: SupabaseClient, orgId: string): Promise<GraphPart> {
  const [entityTotal, entityKinds, confirmed, suggested, rejected, edgeTypes] = await Promise.all([
    headCount(db, "entities", orgId),
    rowsOf<{ kind: string }>(db.from("entities").select("kind").eq("org_id", orgId).limit(5000)),
    headCount(db, "knowledge_relationships", orgId, (q) => q.eq("status", "confirmed")),
    headCount(db, "knowledge_relationships", orgId, (q) => q.eq("status", "suggested")),
    headCount(db, "knowledge_relationships", orgId, (q) => q.eq("status", "rejected")),
    rowsOf<{ relationship_type: string }>(db.from("knowledge_relationships").select("relationship_type").eq("org_id", orgId).in("status", ["confirmed", "suggested"]).limit(5000)),
  ]);
  const kinds = new Map<string, number>();
  for (const e of entityKinds) bump(kinds, e.kind || "project");
  const types = new Map<string, number>();
  for (const e of edgeTypes) bump(types, e.relationship_type);
  return {
    entities: { total: entityTotal, byKind: ranked(kinds, humanize, 10) },
    relationships: { confirmed, suggested, rejected, byType: ranked(types, relationshipLabel, 8) },
  };
}

async function taxonomyPart(db: SupabaseClient, orgId: string): Promise<TaxonomyPart> {
  const [approved, pending, latest] = await Promise.all([
    headCount(db, "taxonomy_values", orgId, (q) => q.eq("status", "approved")),
    headCount(db, "taxonomy_values", orgId, (q) => q.eq("status", "proposed")),
    rowsOf<{ kind: string; value: string; domain: string | null; object_type: string | null; created_at: string }>(
      db.from("taxonomy_values").select("kind, value, domain, object_type, created_at").eq("org_id", orgId).eq("status", "proposed").order("created_at", { ascending: false }).limit(5)
    ),
  ]);
  return {
    approved,
    pending,
    latestProposals: latest.map((p) => ({ kind: p.kind, value: p.value, domain: p.domain, objectType: p.object_type, createdAt: p.created_at })),
  };
}

async function ingestionPart(db: SupabaseClient, orgId: string): Promise<IngestionPart> {
  const [week, dedup, last] = await Promise.all([
    rowsOf<{ stage: string }>(db.from("ingestion_decisions").select("stage").eq("org_id", orgId).gte("created_at", iso(7 * DAY_MS)).limit(5000)),
    rowsOf<{ decision: string }>(db.from("ingestion_decisions").select("decision").eq("org_id", orgId).eq("stage", "dedup").gte("created_at", iso(30 * DAY_MS)).limit(5000)),
    rowsOf<{ created_at: string }>(db.from("ingestion_decisions").select("created_at").eq("org_id", orgId).order("created_at", { ascending: false }).limit(1)),
  ]);
  const stages = new Map<string, number>();
  for (const r of week) bump(stages, r.stage);
  const dedupLast30d = { new: 0, enrich: 0, duplicate: 0, conflict: 0 };
  for (const r of dedup) {
    const d = r.decision === "forced_new" ? "new" : r.decision;
    if (d in dedupLast30d) dedupLast30d[d as keyof typeof dedupLast30d] += 1;
  }
  return { decisionsLast7d: week.length, byStage: ranked(stages, humanize), dedupLast30d, lastDecisionAt: last[0]?.created_at ?? null };
}

async function performancePart(db: SupabaseClient, orgId: string): Promise<PerformancePart> {
  const [metrics, headlineRows, latest] = await Promise.all([
    headCount(db, "metrics", orgId),
    rowsOf<{ metric_key: string; label: string | null; value: number; unit: string | null; period_end: string | null; created_at: string }>(
      db.from("metrics").select("metric_key, label, value, unit, period_end, created_at").eq("org_id", orgId).in("metric_key", HEADLINE_METRIC_KEYS).order("created_at", { ascending: false }).limit(30)
    ),
    rowsOf<{ period_end: string | null }>(db.from("metrics").select("period_end").eq("org_id", orgId).order("period_end", { ascending: false, nullsFirst: false }).limit(1)),
  ]);
  // Latest value per headline key (rows are newest first).
  const seen = new Set<string>();
  const headline: PerformancePart["headline"] = [];
  for (const r of headlineRows) {
    if (seen.has(r.metric_key)) continue;
    seen.add(r.metric_key);
    headline.push({ key: r.metric_key, label: r.label ?? humanize(r.metric_key), value: Number(r.value), unit: r.unit, periodEnd: r.period_end });
  }
  headline.sort((a, b) => HEADLINE_METRIC_KEYS.indexOf(a.key) - HEADLINE_METRIC_KEYS.indexOf(b.key));
  return { metrics, headline, latestPeriod: latest[0]?.period_end ?? null };
}

async function retrievalPart(db: SupabaseClient, orgId: string): Promise<RetrievalPart> {
  const since = iso(7 * DAY_MS);
  const [queries, usage] = await Promise.all([
    rowsOf<QueryRowLite>(db.from("query_log").select("mode, grounded, refused").eq("org_id", orgId).gte("created_at", since).limit(5000)),
    // Latency lives on usage_events (chat calls); optional — a failure here only blanks the latency.
    part(() => rowsOf<{ latency_ms: number | null }>(db.from("usage_events").select("latency_ms").eq("org_id", orgId).eq("kind", "chat").gte("created_at", since).limit(5000))),
  ]);
  const latencies = (usage ?? []).map((u) => Number(u.latency_ms)).filter((n) => Number.isFinite(n));
  return summarizeQueries(queries, latencies, 7);
}

async function promptsPart(db: SupabaseClient, orgId: string): Promise<{ published: string[]; missing: string[] }> {
  const rows = await rowsOf<{ use_case: string }>(db.from("prompts").select("use_case").eq("org_id", orgId).eq("is_active", true).in("use_case", REQUIRED_PROMPTS).limit(50));
  const published = Array.from(new Set(rows.map((r) => r.use_case)));
  return { published, missing: REQUIRED_PROMPTS.filter((p) => !published.includes(p)) };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function getBrainOverview(db: SupabaseClient, orgId: string): Promise<BrainOverview> {
  const [objects, lanes, learning, graph, taxonomy, ingestion, performance, retrieval, prompts, settings, openaiKey, anthropicKey] = await Promise.all([
    part(() => objectsPart(db, orgId)),
    part(() => lanesPart(db, orgId)),
    part(() => learningPart(db, orgId)),
    part(() => graphPart(db, orgId)),
    part(() => taxonomyPart(db, orgId)),
    part(() => ingestionPart(db, orgId)),
    part(() => performancePart(db, orgId)),
    part(() => retrievalPart(db, orgId)),
    part(() => promptsPart(db, orgId)),
    // Settings failing must not take the whole overview down (the route promises no 5xx).
    part(() => loadSettings(orgId, db)),
    part(async () => Boolean(await getProviderKey("openai"))),
    part(async () => Boolean(await getProviderKey("anthropic"))),
  ]);

  const feats = settings?.settings.features;
  const flags = {
    orchestrator: feats?.orchestrator ?? false,
    autoWorkMode: feats?.autoWorkMode ?? false,
    relationshipExpansion: feats?.relationshipExpansion ?? false,
    learningDetection: feats?.learningDetection ?? false,
  };
  const providers = { openai: openaiKey ?? false, anthropic: anthropicKey ?? false };

  const health = healthChecklist({
    migration: objects !== null,
    objectsTotal: objects?.total ?? null,
    promptsMissing: prompts?.missing ?? null,
    pendingTaxonomy: taxonomy?.pending ?? null,
    pendingRelationships: graph?.relationships.suggested ?? null,
    pendingFollowUps: learning ? learning.pendingFollowUps + learning.suggestedEvidenceEdges : null,
    staleObjects: objects?.needsVerification.count ?? null,
    orchestrator: flags.orchestrator,
    openaiKey: providers.openai,
    anthropicKey: providers.anthropic,
  });

  return {
    generatedAt: new Date().toISOString(),
    objects,
    lanes,
    learning,
    graph,
    taxonomy,
    ingestion,
    performance,
    retrieval,
    prompts,
    flags,
    providers,
    health,
  };
}
