// Read-side of the Operating Intelligence system for SPOKES (scoped keys):
// the "Brain map" (counts + filtered object list), a single object's detail with
// its graph neighbourhood, and the Organizational Learning list.
//
// Everything is org-scoped by the caller (org from the key, never the request),
// and every query carries an explicit org_id filter. Sensitive business-reality
// material (calls, call scores, transcripts, KPI reports, the call-score team
// snapshot) is hidden when the spoke asks for `sensitive=0`.
//
// The pure helpers (isSensitiveObject, projectObject, aggregateObjectCounts,
// truncateMarkdown, the param parsers) are DB-free so they can be unit-tested.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isCurrent, realityBucketOf, slugify } from "@/lib/intelligence-taxonomy";
import {
  OBJECT_COLUMNS,
  getObject,
  getObjectByRef,
  getObjectsByIds,
  listRelationshipsFor,
  isMissingRelation,
  type KnowledgeObjectRow,
  type SourceClaim,
  type SourceRecord,
} from "@/lib/knowledge-store";

// ---------------------------------------------------------------------------
// Contracts (what the spoke receives)
// ---------------------------------------------------------------------------

export interface KnowledgeObjectSummary {
  id: string;
  ref: string;
  name: string;
  summary: string | null;
  intelligence_class: string;
  domain: string;
  object_type: string;
  subtype: string | null;
  tags: string[];
  authority: string;
  founder_endorsement: string | null;
  implementation_status: string;
  internal_validation: string;
  status: string;
  current: boolean;
  priority: string;
  updated_at: string;
  last_verified_at: string | null;
  source_platform: string | null;
  source_expert: string | null;
}

export interface KnowledgeObjectDetail extends KnowledgeObjectSummary {
  compiled_markdown: string;
  applies_to: string[];
  goals: string[];
  platforms: string[];
  business_functions: string[];
  effective_from: string | null;
  effective_until: string | null;
  source_type: string | null;
  source_url: string | null;
  source_date: string | null;
  source_claims: SourceClaim[];
  sources: SourceRecord[];
  evidence_level: string | null;
  bucket: string | null;
}

export interface KnowledgeCounts {
  total: number;
  byClass: Record<string, number>;
  byDomain: Record<string, number>;
  byType: Record<string, number>;
  learningByType: Record<string, number>;
  entitiesByKind: Record<string, number>;
  relationships: { confirmed: number; suggested: number };
  metrics: number;
}

export interface PageInfo {
  limit: number;
  offset: number;
  returned: number;
}

export interface KnowledgeListParams {
  class: string | null;
  domain: string | null;
  type: string | null;
  q: string | null;
  /** true (default) = sensitive objects may be returned; false = hidden. */
  sensitive: boolean;
  /** raw_archive objects are excluded unless true. */
  includeArchive: boolean;
  limit: number;
  offset: number;
}

export interface KnowledgeListResult {
  counts: KnowledgeCounts;
  objects: KnowledgeObjectSummary[];
  page: PageInfo;
}

export interface RelatedObject {
  id: string;
  type: string;
  direction: "out" | "in";
  status: string;
  ref: string;
  name: string;
  intelligence_class: string;
}

export interface LearningStub {
  id: string;
  ref: string;
  record_type: string;
  title: string;
  status: string;
  department: string | null;
  created_at: string;
}

export interface KnowledgeDetailResult {
  object: KnowledgeObjectDetail;
  relationships: RelatedObject[];
  learning: LearningStub[];
  chunks: number;
}

export interface LearningListParams {
  status: string | null;
  type: string | null;
  limit: number;
  offset: number;
}

export interface LearningListItem {
  id: string;
  ref: string | null;
  record_type: string;
  title: string | null;
  status: string;
  department: string | null;
  owner: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
  metrics_before: Record<string, unknown>;
  metrics_after: Record<string, unknown>;
  missing_evidence: string[];
  playbooks: { ref: string; name: string }[];
  /** The learning object's own ref (a learning record IS a knowledge object). */
  object_ref: string | null;
}

export interface LearningListResult {
  records: LearningListItem[];
  page: PageInfo;
}

/** The learning_records row shape this module reads (migration 0017). */
export interface LearningRecordRow {
  id: string;
  org_id: string;
  object_id: string;
  record_type: string;
  lifecycle_status: string;
  department: string | null;
  owner: string | null;
  metrics_before: Record<string, unknown> | null;
  metrics_after: Record<string, unknown> | null;
  related_playbook_refs: string[] | null;
  missing_evidence: string[] | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Limits + capability
// ---------------------------------------------------------------------------

export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 50;
export const MAX_OFFSET = 10_000;
export const MARKDOWN_MAX_CHARS = 12_000;
/** How many objects the org-wide count aggregation reads at most. */
export const COUNT_SAMPLE_LIMIT = 5000;

/** A key may read the Brain map when it holds EITHER capability. */
export const READ_CAPABILITIES = ["chat", "retrieve"] as const;

export function hasReadCapability(key: { capabilities?: readonly string[] | null }): boolean {
  const caps = key.capabilities ?? [];
  return READ_CAPABILITIES.some((c) => caps.includes(c));
}

// ---------------------------------------------------------------------------
// Sensitivity
// ---------------------------------------------------------------------------

/** Business-reality types that carry raw call material or team KPIs. */
export const SENSITIVE_REALITY_TYPES: readonly string[] = ["call", "call_score", "transcript", "kpi_report"];

/** The auto-generated call-score team snapshot marks itself in attributes. */
export const CALL_SCORES_SNAPSHOT = "call_scores";

/**
 * True for objects a spoke must not show when it asks for `sensitive=0`:
 * business-reality calls / call scores / transcripts / KPI reports, and the
 * call-score team snapshot (attributes.snapshot = 'call_scores') in any class.
 */
export function isSensitiveObject(o: {
  intelligence_class?: string | null;
  object_type?: string | null;
  attributes?: Record<string, unknown> | null;
}): boolean {
  if (o.intelligence_class === "business_reality" && SENSITIVE_REALITY_TYPES.includes(o.object_type ?? "")) return true;
  const snapshot = o.attributes && typeof o.attributes === "object" ? o.attributes["snapshot"] : undefined;
  return snapshot === CALL_SCORES_SNAPSHOT;
}

// ---------------------------------------------------------------------------
// Projections (pure)
// ---------------------------------------------------------------------------

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** The list projection of an object (no markdown, no embedding, no org_id). */
export function projectObject(o: KnowledgeObjectRow, now: Date = new Date()): KnowledgeObjectSummary {
  return {
    id: o.id,
    ref: o.ref,
    name: o.name,
    summary: o.summary ?? null,
    intelligence_class: o.intelligence_class,
    domain: o.domain,
    object_type: o.object_type,
    subtype: o.subtype ?? null,
    tags: list(o.tags),
    authority: o.authority,
    founder_endorsement: o.founder_endorsement ?? null,
    implementation_status: o.implementation_status,
    internal_validation: o.internal_validation,
    status: o.status,
    current: isCurrent(o, now),
    priority: o.priority,
    updated_at: o.updated_at,
    last_verified_at: o.last_verified_at ?? null,
    source_platform: o.source_platform ?? null,
    source_expert: o.source_expert ?? null,
  };
}

/** Bound the compiled markdown a spoke receives; marks the cut explicitly. */
export function truncateMarkdown(md: string | null | undefined, max = MARKDOWN_MAX_CHARS): string {
  const s = (md ?? "").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max).trimEnd()}\n\n… (truncated)`;
}

/** The detail projection: the summary + content, provenance, temporal fields and bucket. */
export function projectObjectDetail(o: KnowledgeObjectRow, now: Date = new Date()): KnowledgeObjectDetail {
  return {
    ...projectObject(o, now),
    compiled_markdown: truncateMarkdown(o.compiled_markdown),
    applies_to: list(o.applies_to),
    goals: list(o.goals),
    platforms: list(o.applies_to_platforms),
    business_functions: list(o.business_functions),
    effective_from: o.effective_from ?? null,
    effective_until: o.effective_until ?? null,
    source_type: o.source_type ?? null,
    source_url: o.source_url ?? null,
    source_date: o.source_date ?? null,
    source_claims: Array.isArray(o.source_claims) ? o.source_claims : [],
    sources: Array.isArray(o.sources) ? o.sources : [],
    evidence_level: o.evidence_level ?? null,
    bucket: o.intelligence_class === "business_reality" ? realityBucketOf(o) : null,
  };
}

// ---------------------------------------------------------------------------
// Counts (pure aggregation)
// ---------------------------------------------------------------------------

export function countBy<T>(rows: T[], pick: (r: T) => string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = pick(r);
    if (!k) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export interface ObjectCountRow {
  intelligence_class?: string | null;
  domain?: string | null;
  object_type?: string | null;
}

/** Org-wide object counts by class / domain / type from a (bounded) row sample. */
export function aggregateObjectCounts(rows: ObjectCountRow[]): Pick<KnowledgeCounts, "total" | "byClass" | "byDomain" | "byType"> {
  return {
    total: rows.length,
    byClass: countBy(rows, (r) => r.intelligence_class),
    byDomain: countBy(rows, (r) => r.domain),
    byType: countBy(rows, (r) => r.object_type),
  };
}

export function emptyCounts(): KnowledgeCounts {
  return {
    total: 0,
    byClass: {},
    byDomain: {},
    byType: {},
    learningByType: {},
    entitiesByKind: {},
    relationships: { confirmed: 0, suggested: 0 },
    metrics: 0,
  };
}

// ---------------------------------------------------------------------------
// Query-string parsing (pure)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s.trim());
}

/** A taxonomy-ish filter value: lower-case slug, or null when empty. */
function slugParam(v: string | null, max = 64): string | null {
  const s = slugify((v ?? "").trim()).slice(0, max);
  return s || null;
}

/**
 * Strip the characters that would break a PostgREST `or(...)` filter or an
 * ilike pattern (`% , ( ) { } " ' \`), collapse whitespace, bound the length.
 */
export function sanitizeSearchTerm(q: string | null | undefined): string {
  return (q ?? "")
    .replace(/[%,(){}"'\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function intParam(v: string | null, fallback: number, min: number, max: number): number {
  if (v == null || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** `sensitive=0` hides sensitive objects; anything else (or absent) allows them. */
export function parseSensitiveFlag(sp: URLSearchParams): boolean {
  return sp.get("sensitive") !== "0";
}

// Source types that carry the sensitive call material. A key restricted to
// source types that exclude them may never see sensitive objects, whatever the
// caller asks for; the query flag can only narrow further.
const SENSITIVE_SOURCE_TYPES = ["call_score", "transcript", "coaching"];

/** Whether the KEY's scope permits sensitive objects (unrestricted, or restricted to a set that includes call material). */
export function keyAllowsSensitive(key: { source_types?: string[] | null }): boolean {
  const st = key.source_types ?? [];
  return st.length === 0 || st.some((t) => SENSITIVE_SOURCE_TYPES.includes(t));
}

/** The key's retrieval scope, applied to the Brain map exactly as to search (rule 2: scope is a retrieval filter). */
export interface ReadScope {
  sourceTypes: string[];
  collectionIds: string[];
}

function scopeRestricted(scope?: ReadScope | null): scope is ReadScope {
  return !!scope && (scope.sourceTypes.length > 0 || scope.collectionIds.length > 0);
}

/** Whether one object's compiled document falls inside the key's scope. */
async function objectInScope(db: SupabaseClient, orgId: string, object: { document_id?: string | null }, scope: ReadScope): Promise<boolean> {
  if (!object.document_id) return false; // no document → nothing a scoped key was granted
  const { data } = await db
    .from("documents")
    .select("source_type, document_collections(collection_id)")
    .eq("org_id", orgId)
    .eq("id", object.document_id)
    .maybeSingle();
  if (!data) return false;
  const row = data as { source_type: string | null; document_collections?: { collection_id: string }[] | null };
  if (scope.sourceTypes.length && !scope.sourceTypes.includes(row.source_type ?? "")) return false;
  if (scope.collectionIds.length) {
    const cols = (row.document_collections ?? []).map((c) => c.collection_id);
    if (!cols.some((c) => scope.collectionIds.includes(c))) return false;
  }
  return true;
}

export function parseKnowledgeListParams(sp: URLSearchParams): KnowledgeListParams {
  const q = sanitizeSearchTerm(sp.get("q"));
  return {
    class: slugParam(sp.get("class")),
    domain: slugParam(sp.get("domain")),
    type: slugParam(sp.get("type")),
    q: q || null,
    sensitive: parseSensitiveFlag(sp),
    includeArchive: sp.get("includeArchive") === "1",
    limit: intParam(sp.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT),
    offset: intParam(sp.get("offset"), 0, 0, MAX_OFFSET),
  };
}

export function parseLearningListParams(sp: URLSearchParams): LearningListParams {
  return {
    status: slugParam(sp.get("status"), 40),
    type: slugParam(sp.get("type"), 40),
    limit: intParam(sp.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT),
    offset: intParam(sp.get("offset"), 0, 0, MAX_OFFSET),
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const MIGRATION_MESSAGE = "The Brain map needs Brain migration 0017 (knowledge_objects). Apply it and try again.";

/** Map a read failure to a JSON response: 503 pre-migration, else 500. */
export function readErrorResponse(e: unknown): Response {
  const err = e as { code?: string; message?: string } | Error;
  const msg = err instanceof Error ? err.message : err?.message ?? "request failed";
  if (isMissingRelation(err as { code?: string; message?: string })) {
    return Response.json({ error: MIGRATION_MESSAGE, migrationMissing: true }, { status: 503 });
  }
  // Public surface: log the detail (table/column names live in PostgREST
  // messages), return a generic message.
  console.error("[v1/knowledge] read failed:", msg);
  return Response.json({ error: "Request failed. Please try again." }, { status: 500 });
}

// ---------------------------------------------------------------------------
// DB helpers (best-effort: never throw)
// ---------------------------------------------------------------------------

type Rows = PromiseLike<{ data: unknown; error: unknown }>;
type Counted = PromiseLike<{ count: number | null; error: unknown }>;

async function safeRows<T>(fn: () => Rows): Promise<T[]> {
  try {
    const { data, error } = await fn();
    if (error) return [];
    return (data ?? []) as T[];
  } catch {
    return [];
  }
}

async function safeCount(fn: () => Counted): Promise<number | null> {
  try {
    const { count, error } = await fn();
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}

/** Org-wide counts, independent of the list filters. Migration-safe (→ zeros). */
async function orgWideCounts(db: SupabaseClient, orgId: string): Promise<KnowledgeCounts> {
  const [objects, objectTotal, learning, entities, confirmed, suggested, metrics] = await Promise.all([
    safeRows<ObjectCountRow>(() =>
      db.from("knowledge_objects").select("id, intelligence_class, domain, object_type").eq("org_id", orgId).limit(COUNT_SAMPLE_LIMIT)
    ),
    safeCount(() => db.from("knowledge_objects").select("id", { count: "exact", head: true }).eq("org_id", orgId)),
    safeRows<{ record_type: string }>(() => db.from("learning_records").select("record_type").eq("org_id", orgId).limit(COUNT_SAMPLE_LIMIT)),
    safeRows<{ kind: string }>(() => db.from("entities").select("kind").eq("org_id", orgId).limit(COUNT_SAMPLE_LIMIT)),
    safeCount(() => db.from("knowledge_relationships").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("status", "confirmed")),
    safeCount(() => db.from("knowledge_relationships").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("status", "suggested")),
    safeCount(() => db.from("metrics").select("id", { count: "exact", head: true }).eq("org_id", orgId)),
  ]);
  const agg = aggregateObjectCounts(objects);
  return {
    ...agg,
    // The exact head count wins over the bounded sample when both are available.
    total: objectTotal ?? agg.total,
    learningByType: countBy(learning, (r) => r.record_type),
    entitiesByKind: countBy(entities, (r) => r.kind),
    relationships: { confirmed: confirmed ?? 0, suggested: suggested ?? 0 },
    metrics: metrics ?? 0,
  };
}

// ---------------------------------------------------------------------------
// listKnowledge — the Brain map
// ---------------------------------------------------------------------------

/** PostgREST `or(...)` clauses that hide sensitive objects (mirrors isSensitiveObject). */
const NOT_SENSITIVE_TYPE_FILTER = `intelligence_class.neq.business_reality,object_type.not.in.(${SENSITIVE_REALITY_TYPES.join(",")})`;
const NOT_SNAPSHOT_FILTER = `attributes->>snapshot.is.null,attributes->>snapshot.neq.${CALL_SCORES_SNAPSHOT}`;

// Org-wide counts change slowly and cost several queries (three bounded scans);
// serve them from a short per-org cache instead of recomputing on every page.
const countsCache = new Map<string, { at: number; counts: KnowledgeCounts }>();
const COUNTS_TTL_MS = 60_000;
async function cachedOrgCounts(db: SupabaseClient, orgId: string): Promise<KnowledgeCounts> {
  const hit = countsCache.get(orgId);
  if (hit && Date.now() - hit.at < COUNTS_TTL_MS) return hit.counts;
  const counts = await orgWideCounts(db, orgId);
  countsCache.set(orgId, { at: Date.now(), counts });
  return counts;
}

export async function listKnowledge(db: SupabaseClient, orgId: string, params: KnowledgeListParams, scope?: ReadScope | null): Promise<KnowledgeListResult> {
  // A restricted key sees only objects whose compiled document is inside its
  // source-type / collection grant (server-side join; objects without a
  // document are invisible to it). An unrestricted key sees the whole org.
  const restricted = scopeRestricted(scope);
  const select = restricted
    ? `${OBJECT_COLUMNS}, documents!inner(source_type${scope.collectionIds.length ? ", document_collections!inner(collection_id)" : ""})`
    : OBJECT_COLUMNS;
  let q = db.from("knowledge_objects").select(select).eq("org_id", orgId);
  if (restricted && scope.sourceTypes.length) q = q.in("documents.source_type", scope.sourceTypes);
  if (restricted && scope.collectionIds.length) q = q.in("documents.document_collections.collection_id", scope.collectionIds);
  if (params.class) q = q.eq("intelligence_class", params.class);
  if (params.domain) q = q.eq("domain", params.domain);
  if (params.type) q = q.eq("object_type", params.type);
  if (!params.includeArchive) q = q.neq("intelligence_class", "raw_archive");
  if (!params.sensitive) {
    q = q.or(NOT_SENSITIVE_TYPE_FILTER);
    q = q.or(NOT_SNAPSHOT_FILTER);
  }
  if (params.q) {
    const term = params.q;
    const parts = [`ref.ilike.%${term}%`, `name.ilike.%${term}%`, `summary.ilike.%${term}%`];
    const tag = slugify(term);
    if (tag) parts.push(`tags.cs.{${tag}}`);
    q = q.or(parts.join(","));
  }

  const [listRes, counts] = await Promise.all([
    q.order("updated_at", { ascending: false }).range(params.offset, params.offset + params.limit - 1),
    cachedOrgCounts(db, orgId),
  ]);
  if (listRes.error) throw listRes.error;

  const now = new Date();
  const rows = (listRes.data ?? []) as unknown as KnowledgeObjectRow[];
  // Belt and braces: the DB filter hides sensitive rows; never let one slip through.
  const visible = params.sensitive ? rows : rows.filter((o) => !isSensitiveObject(o));
  const objects = visible.map((o) => projectObject(o, now));

  return {
    counts,
    objects,
    page: { limit: params.limit, offset: params.offset, returned: objects.length },
  };
}

// ---------------------------------------------------------------------------
// getKnowledgeDetail — one object + its neighbourhood
// ---------------------------------------------------------------------------

async function countChunks(db: SupabaseClient, orgId: string, objectId: string): Promise<number> {
  return (await safeCount(() => db.from("chunks").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("object_id", objectId))) ?? 0;
}

async function learningRecordsFor(db: SupabaseClient, orgId: string, objectIds: string[]): Promise<LearningRecordRow[]> {
  const ids = Array.from(new Set(objectIds.filter(Boolean)));
  if (ids.length === 0) return [];
  return safeRows<LearningRecordRow>(() =>
    db.from("learning_records").select("*").eq("org_id", orgId).in("object_id", ids).order("created_at", { ascending: false }).limit(100)
  );
}

/**
 * Resolve `refOrId` (MG-001 / BR-SAL-003, or a uuid) inside the org. Returns
 * null when missing — or when the object is sensitive and `sensitive` is false,
 * so the route answers 404 without revealing the object exists.
 */
export async function getKnowledgeDetail(
  db: SupabaseClient,
  orgId: string,
  refOrId: string,
  opts: { sensitive: boolean; scope?: ReadScope | null }
): Promise<KnowledgeDetailResult | null> {
  const key = (refOrId ?? "").trim();
  if (!key) return null;
  const object = isUuid(key) ? await getObject(db, orgId, key, true) : await getObjectByRef(db, orgId, key, true);
  if (!object) return null;
  if (!opts.sensitive && isSensitiveObject(object)) return null;
  if (scopeRestricted(opts.scope) && !(await objectInScope(db, orgId, object, opts.scope))) return null;

  const [edges, chunks] = await Promise.all([listRelationshipsFor(db, orgId, [object.id], "all"), countChunks(db, orgId, object.id)]);
  const live = edges.filter((e) => e.status !== "rejected");
  const otherIdOf = (e: { source_object_id: string; target_object_id: string }) =>
    e.source_object_id === object.id ? e.target_object_id : e.source_object_id;
  const others = await getObjectsByIds(
    db,
    orgId,
    live.map((e) => otherIdOf(e))
  );

  const relationships: RelatedObject[] = [];
  const visibleNeighbourIds: string[] = [];
  for (const e of live) {
    const other = others.get(otherIdOf(e));
    if (!other) continue; // dangling edge (or not in this org)
    if (!opts.sensitive && isSensitiveObject(other)) continue;
    visibleNeighbourIds.push(other.id);
    relationships.push({
      id: e.id,
      type: e.relationship_type,
      direction: e.source_object_id === object.id ? "out" : "in",
      status: e.status,
      ref: other.ref,
      name: other.name,
      intelligence_class: other.intelligence_class,
    });
  }

  // Learning linked to this object: its own lifecycle row (a learning object)
  // plus the lifecycle rows of every visible neighbour (used_playbook /
  // implemented_in / validated_by / adapted_into … edges all land here).
  const records = await learningRecordsFor(db, orgId, [object.id, ...visibleNeighbourIds]);
  const learning: LearningStub[] = [];
  for (const r of records) {
    const o = r.object_id === object.id ? object : others.get(r.object_id);
    if (!o) continue;
    learning.push({
      id: r.id,
      ref: o.ref,
      record_type: r.record_type,
      title: o.name,
      status: r.lifecycle_status,
      department: r.department ?? null,
      created_at: r.created_at,
    });
  }

  return { object: projectObjectDetail(object), relationships, learning, chunks };
}

// ---------------------------------------------------------------------------
// listLearning — saved Organizational Learning
// ---------------------------------------------------------------------------

export async function listLearning(db: SupabaseClient, orgId: string, params: LearningListParams): Promise<LearningListResult> {
  let q = db.from("learning_records").select("*").eq("org_id", orgId);
  if (params.type) q = q.eq("record_type", params.type);
  if (params.status) q = q.eq("lifecycle_status", params.status);
  const { data, error } = await q.order("created_at", { ascending: false }).range(params.offset, params.offset + params.limit - 1);
  if (error) throw error;
  const records = (data ?? []) as unknown as LearningRecordRow[];

  const learningIds = records.map((r) => r.object_id);
  const learningIdSet = new Set(learningIds);
  const [objects, edges] = await Promise.all([getObjectsByIds(db, orgId, learningIds), listRelationshipsFor(db, orgId, learningIds, "confirmed")]);

  // learning object → the playbooks it used (either edge direction the compiler writes).
  const playbookIds = new Map<string, Set<string>>();
  const add = (learningId: string, playbookId: string) => {
    if (!playbookIds.has(learningId)) playbookIds.set(learningId, new Set());
    playbookIds.get(learningId)!.add(playbookId);
  };
  for (const e of edges) {
    if (e.relationship_type === "used_playbook" && learningIdSet.has(e.source_object_id)) add(e.source_object_id, e.target_object_id);
    else if (e.relationship_type === "implemented_in" && learningIdSet.has(e.target_object_id)) add(e.target_object_id, e.source_object_id);
  }
  const playbooks = await getObjectsByIds(
    db,
    orgId,
    Array.from(playbookIds.values()).flatMap((s) => Array.from(s))
  );

  const items: LearningListItem[] = records.map((r) => {
    const o = objects.get(r.object_id) ?? null;
    const pbs = Array.from(playbookIds.get(r.object_id) ?? [])
      .map((id) => playbooks.get(id))
      .filter((p): p is KnowledgeObjectRow => !!p)
      .map((p) => ({ ref: p.ref, name: p.name }));
    return {
      id: r.id,
      ref: o?.ref ?? null,
      record_type: r.record_type,
      title: o?.name ?? null,
      status: r.lifecycle_status,
      department: r.department ?? null,
      owner: r.owner ?? null,
      summary: o?.summary ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      metrics_before: r.metrics_before ?? {},
      metrics_after: r.metrics_after ?? {},
      missing_evidence: list(r.missing_evidence),
      playbooks: pbs,
      object_ref: o?.ref ?? null,
    };
  });

  return { records: items, page: { limit: params.limit, offset: params.offset, returned: items.length } };
}
