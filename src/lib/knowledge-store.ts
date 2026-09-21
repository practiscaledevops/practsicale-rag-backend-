// Persistence helpers for the Operating Intelligence tables (migration 0017):
// knowledge_objects, taxonomy_values, knowledge_relationships, entities +
// mentions, ingestion_decisions — plus the frontmatter/markdown codec for the
// canonical intelligence object. Server-only (service-role client).
//
// Everything here is org-scoped and graceful: helpers that only add value
// (decision log, mentions, suggestions) never throw, so a compile or a chat turn
// is never broken by a best-effort write.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  slugify,
  formatRef,
  reconcileValue,
  suggestedSubtypes,
  isEntityKind,
  type IntelligenceClass,
  type EntityKind,
} from "@/lib/intelligence-taxonomy";

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface KnowledgeObjectRow {
  id: string;
  org_id: string;
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
  evidence_level: string | null;
  authority: string;
  applies_to: string[];
  goals: string[];
  business_functions: string[];
  applies_to_platforms: string[];
  tags: string[];
  content_format: string | null;
  content_job: string | null;
  funnel_stage: string | null;
  brand: string | null;
  audiences: string[];
  content_length: string | null;
  source_expert: string | null;
  source_type: string | null;
  source_platform: string | null;
  source_url: string | null;
  source_date: string | null;
  source_claims: SourceClaim[];
  sources: SourceRecord[];
  effective_from: string | null;
  effective_until: string | null;
  last_verified_at: string | null;
  version: number;
  document_id: string | null;
  raw_document_id: string | null;
  compiled_markdown: string | null;
  summary: string | null;
  attributes: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceClaim {
  claim: string;
  kind?: string;
  verifiable?: boolean;
  verified?: boolean;
  tested?: boolean;
  note?: string;
}

export interface SourceRecord {
  expert?: string | null;
  type?: string | null;
  platform?: string | null;
  url?: string | null;
  date?: string | null;
  added_at?: string;
  document_id?: string | null;
  note?: string | null;
}

/** Columns for list/detail reads (never the 1024-dim embedding). */
export const OBJECT_COLUMNS =
  "id, org_id, ref, name, intelligence_class, domain, object_type, subtype, status, priority, founder_endorsement, implementation_status, internal_validation, evidence_level, authority, applies_to, goals, business_functions, applies_to_platforms, tags, content_format, content_job, funnel_stage, brand, audiences, content_length, source_expert, source_type, source_platform, source_url, source_date, source_claims, sources, effective_from, effective_until, last_verified_at, version, document_id, raw_document_id, summary, attributes, created_by, created_at, updated_at";

export const OBJECT_COLUMNS_WITH_MARKDOWN = `${OBJECT_COLUMNS}, compiled_markdown`;

/** True when the error means migration 0017 is not applied yet. */
export function isMissingRelation(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return err.code === "42P01" || err.code === "42703" || err.code === "42883" || /does not exist|schema cache/i.test(err.message ?? "");
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

/** Next stable ref for a prefix: MG-001, MG-002, … (max existing + 1). */
export async function nextRef(db: SupabaseClient, orgId: string, prefix: string): Promise<string> {
  const { data } = await db
    .from("knowledge_objects")
    .select("ref")
    .eq("org_id", orgId)
    .like("ref", `${prefix}-%`)
    .limit(2000);
  let max = 0;
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`);
  for (const r of (data ?? []) as { ref: string }[]) {
    const m = re.exec(r.ref);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return formatRef(prefix, max + 1);
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

export async function getObject(db: SupabaseClient, orgId: string, id: string, withMarkdown = true): Promise<KnowledgeObjectRow | null> {
  const { data } = await db
    .from("knowledge_objects")
    .select(withMarkdown ? OBJECT_COLUMNS_WITH_MARKDOWN : OBJECT_COLUMNS)
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  return (data as unknown as KnowledgeObjectRow) ?? null;
}

export async function getObjectByRef(db: SupabaseClient, orgId: string, ref: string, withMarkdown = false): Promise<KnowledgeObjectRow | null> {
  const { data } = await db
    .from("knowledge_objects")
    .select(withMarkdown ? OBJECT_COLUMNS_WITH_MARKDOWN : OBJECT_COLUMNS)
    .eq("org_id", orgId)
    .eq("ref", ref.trim().toUpperCase())
    .maybeSingle();
  return (data as unknown as KnowledgeObjectRow) ?? null;
}

export async function getObjectsByIds(db: SupabaseClient, orgId: string, ids: string[]): Promise<Map<string, KnowledgeObjectRow>> {
  const out = new Map<string, KnowledgeObjectRow>();
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  if (uniq.length === 0) return out;
  try {
    const { data } = await db.from("knowledge_objects").select(OBJECT_COLUMNS).eq("org_id", orgId).in("id", uniq);
    for (const o of (data ?? []) as unknown as KnowledgeObjectRow[]) out.set(o.id, o);
  } catch {
    /* pre-migration */
  }
  return out;
}

export interface ObjectMatch {
  id: string;
  ref: string;
  name: string;
  intelligence_class: string;
  domain: string;
  object_type: string;
  subtype: string | null;
  summary: string | null;
  similarity: number;
}

/** Object-level similarity search (dedup + relationship suggestions). [] pre-migration / no vector. */
export async function matchObjects(
  db: SupabaseClient,
  orgId: string,
  embedding: number[],
  opts: { classes?: string[]; domains?: string[]; count?: number } = {}
): Promise<ObjectMatch[]> {
  if (!embedding.some((v) => v !== 0)) return [];
  try {
    const { data, error } = await db.rpc("match_knowledge_objects", {
      p_org_id: orgId,
      query_embedding: embedding,
      p_classes: opts.classes ?? [],
      p_domains: opts.domains ?? [],
      match_count: opts.count ?? 8,
    });
    if (error) return [];
    return (data ?? []) as ObjectMatch[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Taxonomy (controlled + extensible)
// ---------------------------------------------------------------------------

export interface TaxonomyValueRow {
  id: string;
  kind: string;
  intelligence_class: string | null;
  domain: string | null;
  object_type: string | null;
  value: string;
  label: string | null;
  status: "approved" | "proposed" | "rejected";
  proposed_by: string;
  usage_count: number;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export async function listTaxonomyValues(
  db: SupabaseClient,
  orgId: string,
  opts: { kind?: string; domain?: string | null; objectType?: string | null; includeProposed?: boolean; includeRejected?: boolean } = {}
): Promise<TaxonomyValueRow[]> {
  try {
    let q = db.from("taxonomy_values").select("*").eq("org_id", orgId);
    if (opts.kind) q = q.eq("kind", opts.kind);
    if (opts.domain) q = q.eq("domain", opts.domain);
    if (opts.objectType) q = q.eq("object_type", opts.objectType);
    if (!opts.includeRejected) q = q.neq("status", "rejected");
    if (!opts.includeProposed) q = q.eq("status", "approved");
    const { data } = await q.order("usage_count", { ascending: false }).limit(500);
    return (data ?? []) as TaxonomyValueRow[];
  } catch {
    return [];
  }
}

export interface EnsureTaxonomyInput {
  kind: string;
  value: string;
  label?: string | null;
  intelligenceClass?: string | null;
  domain?: string | null;
  objectType?: string | null;
  proposedBy: "ai" | "user" | "system";
  autoApprove: boolean;
}

export interface EnsureTaxonomyResult {
  value: string;
  status: "approved" | "proposed" | "rejected";
  created: boolean;
  /** When an existing value was reused instead of the proposed one. */
  reconciledFrom?: string;
  similarity?: number;
}

/**
 * Reuse an existing taxonomy value when one semantically matches; otherwise
 * create it (approved when autoApprove, else a PROPOSAL for the queue). Bumps
 * usage_count on reuse. The predefined (code) values are passed by the caller
 * as `known` so they are reconciled against too.
 */
export async function ensureTaxonomyValue(
  db: SupabaseClient,
  orgId: string,
  input: EnsureTaxonomyInput,
  known: string[] = []
): Promise<EnsureTaxonomyResult> {
  const proposed = slugify(input.value);
  if (!proposed) return { value: "", status: "rejected", created: false };

  // Candidates: predefined + DB (approved and proposed, so we don't re-propose).
  const dbRows = await listTaxonomyValues(db, orgId, {
    kind: input.kind,
    domain: input.kind === "subtype" ? input.domain ?? undefined : undefined,
    objectType: input.kind === "subtype" ? input.objectType ?? undefined : undefined,
    includeProposed: true,
  });
  const existing = Array.from(new Set([...known.map(slugify), ...dbRows.map((r) => r.value)])).filter(Boolean);
  const hit = reconcileValue(proposed, existing, 0.6);

  if (hit) {
    const row = dbRows.find((r) => r.value === hit.value);
    if (row) {
      await db.from("taxonomy_values").update({ usage_count: row.usage_count + 1 }).eq("id", row.id).then(() => {}, () => {});
      return { value: hit.value, status: row.status, created: false, ...(hit.value !== proposed ? { reconciledFrom: proposed, similarity: hit.similarity } : {}) };
    }
    // Predefined (code) value: nothing to write.
    return { value: hit.value, status: "approved", created: false, ...(hit.value !== proposed ? { reconciledFrom: proposed, similarity: hit.similarity } : {}) };
  }

  const status: "approved" | "proposed" = input.autoApprove || input.proposedBy === "user" ? "approved" : "proposed";
  try {
    const { error } = await db.from("taxonomy_values").upsert(
      {
        org_id: orgId,
        kind: input.kind,
        intelligence_class: input.intelligenceClass ?? null,
        domain: input.kind === "subtype" ? input.domain ?? null : null,
        object_type: input.kind === "subtype" ? input.objectType ?? null : null,
        value: proposed,
        label: input.label ?? null,
        status,
        proposed_by: input.proposedBy,
        usage_count: 1,
      },
      { onConflict: "org_id,kind,domain,object_type,value", ignoreDuplicates: true }
    );
    if (error && !isMissingRelation(error)) {
      // Unique index uses coalesce() expressions PostgREST can't name → fall back to plain insert-if-absent.
      await db.from("taxonomy_values").insert({
        org_id: orgId,
        kind: input.kind,
        intelligence_class: input.intelligenceClass ?? null,
        domain: input.kind === "subtype" ? input.domain ?? null : null,
        object_type: input.kind === "subtype" ? input.objectType ?? null : null,
        value: proposed,
        label: input.label ?? null,
        status,
        proposed_by: input.proposedBy,
        usage_count: 1,
      }).then(() => {}, () => {});
    }
  } catch {
    /* pre-migration: still return the value so the object can carry it */
  }
  return { value: proposed, status, created: true };
}

/** All subtype values usable for (domain, type): predefined + DB approved (+ proposed if asked). */
export async function knownSubtypes(
  db: SupabaseClient,
  orgId: string,
  domain: string | null | undefined,
  objectType: string | null | undefined,
  includeProposed = true
): Promise<string[]> {
  const seed = suggestedSubtypes(domain, objectType);
  const rows = await listTaxonomyValues(db, orgId, { kind: "subtype", domain, objectType, includeProposed });
  return Array.from(new Set([...seed, ...rows.map((r) => r.value)]));
}

// ---------------------------------------------------------------------------
// Decision log (inspectable)
// ---------------------------------------------------------------------------

export interface DecisionEntry {
  runId?: string | null;
  objectId?: string | null;
  stage: "classify" | "taxonomy" | "dedup" | "compile" | "entities" | "relationships" | "learning" | "guard" | "persist";
  decision: string;
  input?: unknown;
  output?: unknown;
  model?: string | null;
  confidence?: number | null;
  durationMs?: number | null;
}

/** Best-effort append to ingestion_decisions. Never throws. */
export async function logDecision(db: SupabaseClient, orgId: string, e: DecisionEntry): Promise<void> {
  try {
    await db.from("ingestion_decisions").insert({
      org_id: orgId,
      run_id: e.runId ?? null,
      object_id: e.objectId ?? null,
      stage: e.stage,
      decision: e.decision,
      input: compact(e.input),
      output: compact(e.output),
      model: e.model ?? null,
      confidence: e.confidence ?? null,
      duration_ms: e.durationMs ?? null,
    });
  } catch {
    /* best-effort */
  }
}

/** Keep logged payloads bounded (strings truncated, deep objects kept). */
function compact(v: unknown, max = 4000): unknown {
  if (v == null) return {};
  try {
    const s = JSON.stringify(v, (_k, val) => (typeof val === "string" && val.length > 1200 ? val.slice(0, 1200) + "…" : val));
    return s.length > max * 4 ? { truncated: true, preview: s.slice(0, max) } : JSON.parse(s);
  } catch {
    return { unserializable: true };
  }
}

// ---------------------------------------------------------------------------
// Entities + mentions
// ---------------------------------------------------------------------------

export interface EntityInput {
  kind: string;
  name: string;
  role?: string | null;
  value?: string | null;
}

/** Upsert entities (kind + slug) and record their mentions on an object/document. Never throws. */
export async function upsertEntityMentions(
  db: SupabaseClient,
  orgId: string,
  entities: EntityInput[],
  link: { objectId?: string | null; documentId?: string | null }
): Promise<{ entityIds: string[] }> {
  const ids: string[] = [];
  for (const e of entities.slice(0, 40)) {
    const name = (e.name || "").trim();
    const kind: EntityKind = isEntityKind(e.kind) ? e.kind : "project";
    const slug = slugify(name);
    if (!name || !slug) continue;
    try {
      const { data: existing } = await db
        .from("entities")
        .select("id, mention_count")
        .eq("org_id", orgId)
        .eq("kind", kind)
        .eq("slug", slug)
        .maybeSingle();
      let id = (existing as { id?: string } | null)?.id;
      if (id) {
        await db.from("entities").update({ mention_count: ((existing as { mention_count?: number })?.mention_count ?? 0) + 1 }).eq("id", id);
      } else {
        const { data: ins } = await db
          .from("entities")
          .insert({ org_id: orgId, kind, name, slug, mention_count: 1 })
          .select("id")
          .single();
        id = (ins as { id?: string } | null)?.id;
      }
      if (!id) continue;
      ids.push(id);
      await db.from("entity_mentions").insert({
        org_id: orgId,
        entity_id: id,
        object_id: link.objectId ?? null,
        document_id: link.documentId ?? null,
        role: e.role ?? null,
        value: e.value ?? null,
      });
    } catch {
      /* best-effort */
    }
  }
  return { entityIds: ids };
}

// ---------------------------------------------------------------------------
// Relationships (edges)
// ---------------------------------------------------------------------------

export interface RelationshipRow {
  id: string;
  source_object_id: string;
  relationship_type: string;
  target_object_id: string;
  status: "confirmed" | "suggested" | "rejected";
  confidence: number | null;
  origin: string;
  note: string | null;
  created_at: string;
}

export interface EdgeInput {
  sourceId: string;
  type: string;
  targetId: string;
  status?: "confirmed" | "suggested" | "rejected";
  confidence?: number | null;
  origin: "markdown" | "system" | "ai" | "user";
  note?: string | null;
}

/** Upsert an edge; a confirmation upgrades a suggested edge in place. Never throws. */
export async function upsertRelationship(db: SupabaseClient, orgId: string, edge: EdgeInput): Promise<RelationshipRow | null> {
  if (!edge.sourceId || !edge.targetId || edge.sourceId === edge.targetId) return null;
  try {
    const { data: existing } = await db
      .from("knowledge_relationships")
      .select("id, status")
      .eq("source_object_id", edge.sourceId)
      .eq("relationship_type", edge.type)
      .eq("target_object_id", edge.targetId)
      .maybeSingle();
    const status = edge.status ?? "confirmed";
    if (existing) {
      const ex = existing as { id: string; status: string };
      // Never downgrade a confirmed edge to suggested.
      const next = ex.status === "confirmed" && status === "suggested" ? "confirmed" : status;
      const { data } = await db
        .from("knowledge_relationships")
        .update({ status: next, confidence: edge.confidence ?? null, note: edge.note ?? null })
        .eq("id", ex.id)
        .select("*")
        .single();
      return (data as RelationshipRow) ?? null;
    }
    const { data } = await db
      .from("knowledge_relationships")
      .insert({
        org_id: orgId,
        source_object_id: edge.sourceId,
        relationship_type: edge.type,
        target_object_id: edge.targetId,
        status,
        confidence: edge.confidence ?? null,
        origin: edge.origin,
        note: edge.note ?? null,
      })
      .select("*")
      .single();
    return (data as RelationshipRow) ?? null;
  } catch {
    return null;
  }
}

/** Confirmed (by default) edges touching any of the objects, in either direction. */
export async function listRelationshipsFor(
  db: SupabaseClient,
  orgId: string,
  objectIds: string[],
  status: "confirmed" | "suggested" | "all" = "confirmed"
): Promise<RelationshipRow[]> {
  const ids = Array.from(new Set(objectIds.filter(Boolean)));
  if (ids.length === 0) return [];
  try {
    const list = `(${ids.join(",")})`;
    let q = db
      .from("knowledge_relationships")
      .select("*")
      .eq("org_id", orgId)
      .or(`source_object_id.in.${list},target_object_id.in.${list}`);
    if (status !== "all") q = q.eq("status", status);
    const { data } = await q.limit(400);
    return (data ?? []) as RelationshipRow[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Frontmatter + markdown codec
// ---------------------------------------------------------------------------

export interface MarkdownSection {
  heading: string;
  body: string;
}

function yamlScalar(v: unknown): string {
  if (v == null) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  if (s === "") return '""';
  // Quote when the value could be mis-parsed.
  if (/[:#\-\[\]{}&*!|>'"%@`,?]|^\s|\s$|^(true|false|null|yes|no)$/i.test(s) || /^\d/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

function yamlList(items: unknown[], indent = ""): string {
  if (!items.length) return `${indent}[]`;
  return items.map((i) => `${indent}- ${yamlScalar(i)}`).join("\n");
}

/** Generate the YAML frontmatter block for an object (stable key order). */
export function buildFrontmatter(o: Partial<KnowledgeObjectRow> & { ref: string; name: string; intelligence_class: string }): string {
  const lines: string[] = ["---"];
  const put = (k: string, v: unknown) => {
    if (v == null || v === "") return;
    if (Array.isArray(v)) {
      if (v.length === 0) return;
      lines.push(`${k}:`);
      lines.push(yamlList(v, "  "));
    } else {
      lines.push(`${k}: ${yamlScalar(v)}`);
    }
  };
  put("id", o.ref);
  put("name", o.name);
  put("class", o.intelligence_class);
  put("domain", o.domain);
  put("type", o.object_type);
  put("subtype", o.subtype);
  put("status", o.status);
  put("priority", o.priority);
  put("founder_endorsement", o.founder_endorsement);
  put("implementation_status", o.implementation_status);
  put("internal_validation", o.internal_validation);
  put("evidence_level", o.evidence_level);
  put("authority", o.authority);
  put("applies_to", o.applies_to);
  put("goals", o.goals);
  put("business_functions", o.business_functions);
  put("applies_to_platforms", o.applies_to_platforms);
  if (o.content_format || o.content_job || o.funnel_stage || o.brand || (o.audiences && o.audiences.length) || o.content_length) {
    lines.push("content:");
    if (o.content_format) lines.push(`  format: ${yamlScalar(o.content_format)}`);
    if (o.content_job) lines.push(`  job: ${yamlScalar(o.content_job)}`);
    if (o.funnel_stage) lines.push(`  funnel_stage: ${yamlScalar(o.funnel_stage)}`);
    if (o.brand) lines.push(`  brand: ${yamlScalar(o.brand)}`);
    if (o.audiences && o.audiences.length) {
      lines.push("  audiences:");
      lines.push(yamlList(o.audiences, "    "));
    }
    if (o.content_length) lines.push(`  length: ${yamlScalar(o.content_length)}`);
  }
  if (o.source_expert || o.source_type || o.source_platform || o.source_url || o.source_date) {
    lines.push("source:");
    if (o.source_expert) lines.push(`  expert: ${yamlScalar(o.source_expert)}`);
    if (o.source_type) lines.push(`  type: ${yamlScalar(o.source_type)}`);
    if (o.source_platform) lines.push(`  platform: ${yamlScalar(o.source_platform)}`);
    if (o.source_url) lines.push(`  url: ${yamlScalar(o.source_url)}`);
    if (o.source_date) lines.push(`  date: ${yamlScalar(o.source_date)}`);
  }
  put("effective_from", o.effective_from);
  put("effective_until", o.effective_until);
  put("last_verified_at", o.last_verified_at);
  put("version", o.version);
  put("tags", o.tags);
  lines.push("---");
  return lines.join("\n");
}

/** Assemble the canonical markdown: frontmatter + H1 + H2 sections. */
export function assembleMarkdown(frontmatter: string, title: string, sections: MarkdownSection[]): string {
  const body = sections
    .filter((s) => s.heading && s.body && s.body.trim())
    .map((s) => `## ${s.heading.trim()}\n\n${s.body.trim()}`)
    .join("\n\n");
  return `${frontmatter}\n\n# ${title.trim()}\n\n${body}\n`;
}

/** Split the sections back out of a compiled markdown body (H2 = section). */
export function splitSections(markdown: string): { title: string; sections: MarkdownSection[] } {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const lines = body.split(/\r?\n/);
  let title = "";
  const sections: MarkdownSection[] = [];
  let cur: MarkdownSection | null = null;
  for (const line of lines) {
    const h1 = /^#\s+(.+)$/.exec(line);
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h1 && !title && !cur) {
      title = h1[1].trim();
      continue;
    }
    if (h2) {
      if (cur) sections.push({ heading: cur.heading, body: cur.body.trim() });
      cur = { heading: h2[1].trim(), body: "" };
      continue;
    }
    if (cur) cur.body += line + "\n";
  }
  if (cur) sections.push({ heading: cur.heading, body: cur.body.trim() });
  return { title, sections };
}

/**
 * Tolerant frontmatter parser for user-supplied .md objects (a YAML subset:
 * `key: value`, `key:` + `- item` lists, and ONE level of nested `key:` maps).
 * Returns {} when there is no frontmatter.
 */
export function parseFrontmatter(markdown: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!m) return { data: {}, body: markdown };
  const data: Record<string, unknown> = {};
  const lines = m[1].split(/\r?\n/);
  let key: string | null = null;         // current top-level key
  let nested: Record<string, unknown> | null = null;
  let list: unknown[] | null = null;
  let nestedListKey: string | null = null;

  const unq = (s: string): unknown => {
    const t = s.trim();
    if (t === "" ) return "";
    if (/^".*"$/.test(t)) { try { return JSON.parse(t); } catch { return t.slice(1, -1); } }
    if (/^'.*'$/.test(t)) return t.slice(1, -1);
    if (t === "true") return true;
    if (t === "false") return false;
    if (t === "null" || t === "~") return null;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if (/^\[.*\]$/.test(t)) return t.slice(1, -1).split(",").map((x) => unq(x)).filter((x) => x !== "");
    return t;
  };

  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (indent === 0) {
      const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (!kv) continue;
      key = kv[1];
      nested = null; list = null; nestedListKey = null;
      if (kv[2] === "") {
        // Either a list or a nested map follows; decide on the next line.
        data[key] = undefined;
      } else {
        data[key] = unq(kv[2]);
      }
      continue;
    }
    if (!key) continue;

    if (line.startsWith("- ")) {
      const item = unq(line.slice(2));
      if (nested && nestedListKey) {
        (nested[nestedListKey] as unknown[]).push(item);
      } else {
        if (!list) { list = []; data[key] = list; }
        // "- id: X" style object items (related_objects)
        const okv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(String(item));
        if (okv && typeof item === "string") list.push({ [okv[1]]: unq(okv[2]) });
        else list.push(item);
      }
      continue;
    }
    // continuation of an object list item: "  relationship: complements"
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (list && list.length && typeof list[list.length - 1] === "object" && indent >= 4) {
      (list[list.length - 1] as Record<string, unknown>)[kv[1]] = unq(kv[2]);
      continue;
    }
    if (!nested) { nested = {}; data[key] = nested; }
    if (kv[2] === "") { nested[kv[1]] = []; nestedListKey = kv[1]; }
    else { nested[kv[1]] = unq(kv[2]); nestedListKey = null; }
  }
  for (const k of Object.keys(data)) if (data[k] === undefined) data[k] = null;
  return { data, body: markdown.slice(m[0].length) };
}

/** The identity line prepended to every chunk of an object (deterministic context). */
export function objectContextLine(o: {
  ref: string;
  name: string;
  intelligence_class: string;
  domain?: string | null;
  object_type?: string | null;
  subtype?: string | null;
  authority?: string | null;
  founder_endorsement?: string | null;
}): string {
  const path = [o.intelligence_class, o.domain, o.object_type, o.subtype].filter(Boolean).join("/");
  const gov = [o.authority ? `authority ${o.authority}` : "", o.founder_endorsement ? `endorsement ${o.founder_endorsement}` : ""]
    .filter(Boolean)
    .join(", ");
  return `${o.ref} ${o.name} · ${path}${gov ? ` · ${gov}` : ""}`;
}

/** The text embedded at object level (dedup / relationship similarity). */
export function objectEmbeddingText(name: string, summary: string | null, sections: MarkdownSection[]): string {
  const core = sections
    .filter((s) => /definition|core principle|framework|summary|key facts|what we changed|learning|how it works/i.test(s.heading))
    .map((s) => s.body)
    .join("\n")
    .slice(0, 2500);
  return [name, summary ?? "", core].filter(Boolean).join("\n\n");
}
