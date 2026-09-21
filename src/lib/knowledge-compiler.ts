// The Knowledge Compiler — the AI ingestion agent of the Operating Intelligence
// System. Raw human knowledge goes in (a clip transcript, an article, a PDF, a
// report, a note); a structured, machine-usable intelligence object comes out.
//
//   raw source + the human's CLASS choice
//     → understand + extract (remove noise)            classify stage
//     → classify: domain / type / subtype / applies-to / goals / platform /
//       format / tags / provenance / entities            classify stage
//     → reconcile taxonomy (reuse or PROPOSE)            taxonomy stage
//     → search the existing Brain: NEW / ENRICH /
//       DUPLICATE / CONFLICT                              dedup stage
//     → compile the canonical Markdown object            compile stage
//     → semantic chunking (inherits parent metadata)
//     → embed → entities → relationships                 persist stage
//     → ACTIVE IN THE BRAIN
//
// Every automatic decision is logged to ingestion_decisions. Raw source and
// compiled object are stored as SEPARATE documents (raw = raw_archive lane) so a
// conclusion can always be traced to its origin. Two modes:
//   preview — run the AI stages, return the proposal, write NOTHING
//   commit  — persist (optionally from a reviewed preview, with human overrides)
//
// Graceful: every AI stage falls back to a deterministic path (demo mode, no
// key, outage), so a compile never fails because a model was unavailable.

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { structured } from "@/lib/structured";
import { embed } from "@/lib/embeddings";
import { loadSettings, type RagSettings } from "@/lib/settings";
import { getActivePrompts } from "@/lib/prompts-db";
import { ingestOne, reingestDocument } from "@/lib/ingest";
import {
  DOMAINS,
  PLATFORMS,
  FORMATS,
  CONTENT_JOBS,
  FUNNEL_STAGES,
  BRANDS,
  LENGTHS,
  EXTERNAL_SOURCE_PLATFORMS,
  REALITY_BUCKETS,
  SUGGESTED_SUBTYPES,
  isDomain,
  isRealityBucket,
  typesFor,
  suggestedSubtypes,
  defaultAuthority,
  refPrefix,
  slugify,
  reconcileValue,
  isRelationshipType,
  type IntelligenceClass,
  type RealityBucket,
  type Priority,
  type FounderEndorsement,
} from "@/lib/intelligence-taxonomy";
import {
  nextRef,
  getObject,
  getObjectByRef,
  matchObjects,
  ensureTaxonomyValue,
  knownSubtypes,
  listTaxonomyValues,
  logDecision,
  upsertEntityMentions,
  upsertRelationship,
  buildFrontmatter,
  assembleMarkdown,
  splitSections,
  parseFrontmatter,
  objectContextLine,
  objectEmbeddingText,
  OBJECT_COLUMNS,
  type KnowledgeObjectRow,
  type MarkdownSection,
  type EntityInput,
  type DecisionEntry,
  type ObjectMatch,
  type SourceRecord,
} from "@/lib/knowledge-store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompileMode = "preview" | "commit";
export type DedupDecision = "new" | "enrich" | "duplicate" | "conflict";

export interface CompileHints {
  sourceExpert?: string | null;
  sourceType?: string | null;
  sourcePlatform?: string | null;
  sourceUrl?: string | null;
  sourceDate?: string | null;
  domain?: string | null;
  objectType?: string | null;
  subtype?: string | null;
  tags?: string[];
  /** The founder's own words (Founder Brain). */
  isFounderVoice?: boolean;
  /** Learning-record specifics when class = organizational_learning. */
  learning?: {
    recordType?: string | null;
    lifecycleStatus?: string | null;
    department?: string | null;
    owner?: string | null;
    relatedPlaybookRefs?: string[];
    changes?: Record<string, unknown>;
    metricsBefore?: Record<string, unknown>;
    metricsAfter?: Record<string, unknown>;
    confidence?: "low" | "medium" | "high" | null;
    missingEvidence?: string[];
    evidenceDocumentIds?: string[];
    parentRecordId?: string | null;
    source?: "chat" | "manual" | "auto" | "ingest";
  };
}

/** Human edits applied on commit (from the review screen). */
export interface DraftOverrides {
  name?: string;
  domain?: string;
  object_type?: string;
  subtype?: string | null;
  status?: string;
  priority?: Priority;
  founder_endorsement?: FounderEndorsement | null;
  implementation_status?: string;
  internal_validation?: string;
  evidence_level?: string | null;
  authority?: string;
  applies_to?: string[];
  goals?: string[];
  business_functions?: string[];
  applies_to_platforms?: string[];
  tags?: string[];
  content_format?: string | null;
  content_job?: string | null;
  funnel_stage?: string | null;
  brand?: string | null;
  audiences?: string[];
  content_length?: string | null;
  source_expert?: string | null;
  source_type?: string | null;
  source_platform?: string | null;
  source_url?: string | null;
  source_date?: string | null;
  effective_from?: string | null;
  effective_until?: string | null;
  summary?: string;
  /** Edited sections (replaces the compiled ones). */
  sections?: MarkdownSection[];
  /** Edited full markdown (wins over sections). */
  compiled_markdown?: string;
}

export interface CompileInput {
  orgId: string;
  intelligenceClass: IntelligenceClass;
  /** Business Reality bucket the human chose (sets domain defaults + authority + guards). */
  bucket?: RealityBucket | null;
  /** Raw source text (already extracted from the file/clip). */
  text: string;
  title?: string | null;
  hints?: CompileHints;
  mode: CompileMode;
  /** Commit from a reviewed preview: reuse its AI output and apply human edits. */
  preview?: CompilePreview | null;
  overrides?: DraftOverrides | null;
  /** Ignore the dedup verdict and create a new object anyway. */
  forceNew?: boolean;
  /** Explicit dedup target chosen in review (ref). */
  dedupTargetRef?: string | null;
  /** Allow Company Truth from an external (social/expert) source. */
  confirmTruth?: boolean;
  /** Store the raw source as a raw_archive document (default: playbooks + platform intelligence). */
  storeRaw?: boolean;
  runId?: string | null;
  createdBy?: string | null;
}

export interface ObjectDraft {
  ref: string;
  name: string;
  intelligence_class: IntelligenceClass;
  domain: string;
  object_type: string;
  subtype: string | null;
  status: string;
  priority: Priority;
  founder_endorsement: FounderEndorsement | null;
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
  source_claims: { claim: string; kind?: string; verifiable?: boolean }[];
  effective_from: string | null;
  effective_until: string | null;
  summary: string;
  teaching_core: string;
  sections: MarkdownSection[];
  compiled_markdown: string;
  bucket: RealityBucket | null;
}

export interface TaxonomyOutcome {
  kind: string;
  proposed: string;
  value: string;
  status: "approved" | "proposed" | "rejected";
  reconciledFrom?: string;
  similarity?: number;
}

export interface SuggestedRelationship {
  targetId: string;
  targetRef: string;
  targetName: string;
  type: string;
  confidence: number;
  reason: string;
}

export interface CompilePreview {
  draft: ObjectDraft;
  entities: EntityInput[];
  keyConcepts: string[];
  taxonomy: TaxonomyOutcome[];
  neighbors: ObjectMatch[];
  dedup: { decision: DedupDecision; targetRef: string | null; targetId: string | null; targetName: string | null; similarity: number | null; rationale: string; enrichment: MarkdownSection[]; conflictSummary: string | null };
  suggestedRelationships: SuggestedRelationship[];
  markdownRelationships: { ref: string; type: string }[];
  models: { classify?: string; compile?: string; dedup?: string };
  warnings: string[];
}

export interface CompileResult extends CompilePreview {
  mode: CompileMode;
  blocked: { reason: string } | null;
  /** Set on commit. */
  object: KnowledgeObjectRow | null;
  documentId: string | null;
  rawDocumentId: string | null;
  chunks: number;
  /** For enrich/duplicate: the existing object that absorbed the source. */
  target: KnowledgeObjectRow | null;
  log: DecisionEntry[];
}

// ---------------------------------------------------------------------------
// Schemas (structured LLM output)
// ---------------------------------------------------------------------------

const ClassifySchema = z.object({
  name: z.string().min(1).max(200),
  summary: z.string().max(2000).default(""),
  teaching_core: z.string().max(24000).default(""),
  domain: z.string().default("other"),
  object_type: z.string().default(""),
  subtype: z.string().nullable().optional(),
  subtype_is_new: z.boolean().optional(),
  applies_to: z.array(z.string()).default([]),
  goals: z.array(z.string()).default([]),
  business_functions: z.array(z.string()).default([]),
  applies_to_platforms: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  content: z
    .object({
      format: z.string().nullable().optional(),
      content_job: z.string().nullable().optional(),
      funnel_stage: z.string().nullable().optional(),
      brand: z.string().nullable().optional(),
      audiences: z.array(z.string()).optional(),
      length: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  source: z
    .object({
      expert: z.string().nullable().optional(),
      type: z.string().nullable().optional(),
      platform: z.string().nullable().optional(),
      url: z.string().nullable().optional(),
      date: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  source_claims: z.array(z.object({ claim: z.string(), kind: z.string().optional(), verifiable: z.boolean().optional() })).default([]),
  entities: z
    .array(z.object({ kind: z.string(), name: z.string(), role: z.string().nullable().optional(), value: z.string().nullable().optional() }))
    .default([]),
  key_concepts: z.array(z.string()).default([]),
  effective_from: z.string().nullable().optional(),
  effective_until: z.string().nullable().optional(),
  is_historical: z.boolean().optional(),
  priority: z.enum(["core", "strong", "normal", "low"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
  relationship_hints: z.array(z.object({ ref_or_name: z.string(), relationship: z.string() })).default([]),
});
type Classified = z.infer<typeof ClassifySchema>;

const CompileSchema = z.object({
  sections: z.array(z.object({ heading: z.string(), body: z.string() })).min(1),
});

const DedupSchema = z.object({
  decision: z.enum(["new", "enrich", "duplicate", "conflict"]),
  target_ref: z.string().nullable().optional(),
  rationale: z.string().default(""),
  confidence: z.number().min(0).max(1).optional(),
  enrichment: z.object({ additions: z.array(z.object({ heading: z.string(), body: z.string() })).default([]) }).nullable().optional(),
  conflict_summary: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_SOURCE_CHARS = 60_000;

function clean(s: unknown): string {
  return typeof s === "string" ? s.trim() : "";
}
function cleanNull(s: unknown): string | null {
  const t = clean(s);
  return t ? t : null;
}
function slugList(v: unknown, max = 12): string[] {
  if (!Array.isArray(v)) return [];
  return Array.from(new Set(v.map((x) => slugify(String(x))).filter(Boolean))).slice(0, max);
}
/** Short labels only (applies_to / goals / functions / audiences): the classifier
 *  sometimes returns sentences; those are noise as facets. */
function labelList(v: unknown, max = 8): string[] {
  return slugList(v, 40)
    .filter((s) => s.length <= 32 && s.split("_").length <= 3)
    .slice(0, max);
}

/** Buckets that ARE a domain: the human's choice wins over the classifier. */
const BUCKET_DOMAIN: Partial<Record<RealityBucket, string>> = {
  founder_brain: "founder",
  brand_voice: "brand",
  approved_content: "content",
  proof_evidence: "customer",
};

/** Whether a reality source should be preserved verbatim (its own structure)
 *  instead of rewritten by the compile model: it already has headings, or it is
 *  long enough that a rewrite would lose facts (and risk a truncated response). */
function shouldPreserveStructure(text: string): boolean {
  const headings = (text.match(/^#{1,3}\s+\S/gm) ?? []).length;
  return headings >= 2 || text.length > 6000;
}

/** Build sections from the source's own headings (verbatim), framed with a
 *  summary, the stated facts/claims, the entities and an evidence note. */
function preserveSections(
  draft: ObjectDraft,
  sourceText: string,
  entities: EntityInput[]
): MarkdownSection[] {
  const out: MarkdownSection[] = [];
  if (draft.summary) out.push({ heading: "Summary", body: draft.summary });
  if (draft.source_claims.length) {
    out.push({ heading: "Key Facts", body: draft.source_claims.slice(0, 40).map((c) => `- ${c.claim}`).join("\n") });
  }
  // Split the ORIGINAL text on its headings (levels 1–3); text before the first heading = Context.
  const lines = sourceText.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").split(/\r?\n/);
  let cur: MarkdownSection | null = null;
  let preamble = "";
  const seen = new Set(out.map((s) => s.heading.toLowerCase()));
  const push = (s: MarkdownSection) => {
    const body = s.body.trim();
    if (!body) return;
    let heading = s.heading.trim() || "Details";
    let n = 2;
    while (seen.has(heading.toLowerCase())) heading = `${s.heading.trim() || "Details"} (${n++})`;
    seen.add(heading.toLowerCase());
    out.push({ heading, body });
  };
  for (const line of lines) {
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) {
      if (cur) push(cur);
      else if (preamble.trim()) push({ heading: "Context", body: preamble });
      cur = { heading: h[2].replace(/^\d+[.)]\s*/, "").trim(), body: "" };
    } else if (cur) cur.body += line + "\n";
    else preamble += line + "\n";
  }
  if (cur) push(cur);
  else if (preamble.trim()) push({ heading: "Details", body: preamble });
  if (entities.length) {
    out.push({
      heading: "Entities Involved",
      body: entities.slice(0, 30).map((e) => `- ${e.kind}: ${e.name}${e.role ? ` (${e.role})` : ""}`).join("\n"),
    });
  }
  out.push({
    heading: "Evidence Notes",
    body: `Preserved verbatim from the internal source${draft.source_date ? ` dated ${draft.source_date}` : ""}${draft.bucket ? ` (${draft.bucket.replace(/_/g, " ")})` : ""}. Facts, numbers and names are as stated there; treat them as current unless an effective_until date says otherwise.`,
  });
  return out;
}
function pickAllowed(v: unknown, allowed: readonly string[]): string | null {
  const s = slugify(clean(v));
  if (!s) return null;
  const hit = reconcileValue(s, [...allowed], 0.6);
  return hit ? hit.value : null;
}
function defaultTypeFor(cls: IntelligenceClass, domain: string): string {
  const t = typesFor(cls, domain);
  if (cls === "playbook") return "framework";
  if (cls === "business_reality") return "document";
  if (cls === "organizational_learning") return "learning";
  if (cls === "platform_intelligence") return "best_practice";
  return t[0]?.id ?? "document";
}
function isoDate(v: unknown): string | null {
  const s = clean(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
function dateOnly(v: unknown): string | null {
  const iso = isoDate(v);
  return iso ? iso.slice(0, 10) : null;
}

function classTemplateName(cls: IntelligenceClass): string {
  switch (cls) {
    case "playbook":
      return "PLAYBOOK";
    case "business_reality":
      return "BUSINESS_REALITY";
    case "organizational_learning":
      return "ORGANIZATIONAL_LEARNING";
    case "platform_intelligence":
      return "PLATFORM_INTELLIGENCE";
    default:
      return "BUSINESS_REALITY";
  }
}

/** Deterministic sections when the compile model is unavailable. */
function fallbackSections(cls: IntelligenceClass, summary: string, core: string): MarkdownSection[] {
  const body = core || summary;
  switch (cls) {
    case "playbook":
      return [
        { heading: "Definition", body: summary || body.slice(0, 600) },
        { heading: "Source Teaching", body },
      ];
    case "organizational_learning":
      return [
        { heading: "Context", body: summary || body.slice(0, 600) },
        { heading: "What We Changed", body },
      ];
    case "platform_intelligence":
      return [
        { heading: "What It Is", body: summary || body.slice(0, 600) },
        { heading: "How It Works", body },
      ];
    default:
      return [
        { heading: "Summary", body: summary || body.slice(0, 600) },
        { heading: "Details", body },
      ];
  }
}

// ---------------------------------------------------------------------------
// Stage 1 — classify + extract
// ---------------------------------------------------------------------------

async function classifyStage(
  db: SupabaseClient,
  input: CompileInput,
  settings: RagSettings,
  prompt: string,
  log: DecisionEntry[]
): Promise<{ c: Classified; model: string | null }> {
  const cls = input.intelligenceClass;
  const bucket = input.bucket ?? null;
  const hints = input.hints ?? {};
  const text = input.text.length > MAX_SOURCE_CHARS ? input.text.slice(0, MAX_SOURCE_CHARS) : input.text;

  // Taxonomy the classifier may reuse: predefined subtypes (all) + DB-approved.
  const approved = await listTaxonomyValues(db, input.orgId, { kind: "subtype" });
  const subtypeTable = Object.entries(SUGGESTED_SUBTYPES)
    .map(([k, v]) => `${k}: ${v.join(", ")}`)
    .concat(approved.map((r) => `${r.domain ?? "*"}/${r.object_type ?? "*"}: ${r.value}`))
    .join("\n");
  const domainList = DOMAINS.map((d) => d.id).join(", ");
  const typeList = typesFor(cls, "content").map((t) => t.id).join(", ");
  const bucketDef = bucket ? REALITY_BUCKETS.find((b) => b.id === bucket) : null;

  const userPrompt = [
    `INTELLIGENCE CLASS (chosen by the human): ${cls}${bucketDef ? ` — bucket: ${bucketDef.label} (${bucketDef.description})` : ""}`,
    hints.isFounderVoice ? "This source is the FOUNDER's own words (Founder Brain): keep his beliefs and experience as stated, first person where present." : "",
    hints.domain ? `Domain hint from the human: ${hints.domain}` : "",
    hints.objectType ? `Type hint from the human: ${hints.objectType}` : "",
    hints.subtype ? `Subtype hint from the human: ${hints.subtype}` : "",
    hints.sourceExpert || hints.sourcePlatform || hints.sourceType || hints.sourceUrl || hints.sourceDate
      ? `Source hints: expert=${hints.sourceExpert ?? ""} platform=${hints.sourcePlatform ?? ""} type=${hints.sourceType ?? ""} url=${hints.sourceUrl ?? ""} date=${hints.sourceDate ?? ""}`
      : "",
    input.title ? `Title / filename: ${input.title}` : "",
    "",
    `Allowed domains: ${domainList}`,
    `Allowed object types for this class: ${typeList}`,
    `Existing subtypes (domain/type: values) — reuse when adequate:\n${subtypeTable}`,
    "",
    "SOURCE:",
    text,
  ]
    .filter((l) => l !== "")
    .join("\n");

  const started = Date.now();
  const res = await structured({
    tier: settings.intelligence.classifyTier,
    system: prompt,
    prompt: userPrompt,
    schema: ClassifySchema,
    maxTokens: 6000,
  });

  if (res) {
    log.push({ stage: "classify", decision: "llm", input: { chars: text.length, class: cls, bucket }, output: { ...res.object, teaching_core: undefined }, model: res.model, confidence: res.object.confidence ?? null, durationMs: Date.now() - started });
    return { c: res.object, model: res.model };
  }

  // Deterministic fallback (demo / no key / outage).
  const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 3) ?? "Untitled";
  const name = clean(input.title) || firstLine.replace(/^#+\s*/, "").slice(0, 120);
  const domain = hints.domain && isDomain(hints.domain) ? hints.domain : bucketDef?.domain ?? "other";
  const fallback: Classified = {
    name,
    summary: text.replace(/\s+/g, " ").slice(0, 400),
    teaching_core: text.slice(0, 24000),
    domain,
    object_type: hints.objectType ?? defaultTypeFor(cls, domain),
    subtype: hints.subtype ?? null,
    applies_to: [],
    goals: [],
    business_functions: [],
    applies_to_platforms: [],
    tags: hints.tags ?? [],
    source_claims: [],
    entities: [],
    key_concepts: [],
    relationship_hints: [],
  };
  log.push({ stage: "classify", decision: "fallback", input: { chars: text.length, class: cls }, output: { name, domain, object_type: fallback.object_type }, durationMs: Date.now() - started });
  return { c: fallback, model: null };
}

// ---------------------------------------------------------------------------
// Stage 2 — taxonomy reconciliation → draft
// ---------------------------------------------------------------------------

async function draftFromClassification(
  db: SupabaseClient,
  input: CompileInput,
  c: Classified,
  settings: RagSettings,
  write: boolean,
  log: DecisionEntry[]
): Promise<{ draft: ObjectDraft; taxonomy: TaxonomyOutcome[]; warnings: string[] }> {
  const cls = input.intelligenceClass;
  const hints = input.hints ?? {};
  const warnings: string[] = [];
  const taxonomy: TaxonomyOutcome[] = [];
  const bucket = input.bucket ?? null;
  const bucketDef = bucket ? REALITY_BUCKETS.find((b) => b.id === bucket) : null;

  // Domain: must be predefined (reconcile spelling), else the bucket/hint default.
  let domain = hints.domain && isDomain(hints.domain) ? hints.domain : null;
  if (!domain) {
    const hit = reconcileValue(c.domain, DOMAINS.map((d) => d.id), 0.6);
    domain = hit?.value ?? bucketDef?.domain ?? "other";
    if (!hit && c.domain) warnings.push(`Domain "${c.domain}" is not in the taxonomy; used "${domain}".`);
  }
  if (cls === "platform_intelligence") domain = "platform";
  if (bucket && BUCKET_DOMAIN[bucket]) domain = BUCKET_DOMAIN[bucket]!;

  // Type: must be one the class allows (content-only types need domain=content).
  const allowedTypes = typesFor(cls, domain).map((t) => t.id);
  let objectType = hints.objectType && allowedTypes.includes(hints.objectType) ? hints.objectType : null;
  if (!objectType) {
    const hit = reconcileValue(c.object_type, allowedTypes, 0.6);
    objectType = hit?.value ?? defaultTypeFor(cls, domain);
    if (!hit && c.object_type) warnings.push(`Type "${c.object_type}" is not allowed for ${cls}; used "${objectType}".`);
  }

  // Subtype: controlled + extensible.
  let subtype: string | null = null;
  const proposedSubtype = clean(hints.subtype) || clean(c.subtype);
  if (proposedSubtype) {
    if (write) {
      const r = await ensureTaxonomyValue(
        db,
        input.orgId,
        { kind: "subtype", value: proposedSubtype, intelligenceClass: cls, domain, objectType, proposedBy: hints.subtype ? "user" : "ai", autoApprove: settings.intelligence.taxonomyAutoApprove },
        suggestedSubtypes(domain, objectType)
      );
      subtype = r.value || null;
      taxonomy.push({ kind: "subtype", proposed: proposedSubtype, value: r.value, status: r.status, reconciledFrom: r.reconciledFrom, similarity: r.similarity });
    } else {
      const known = await knownSubtypes(db, input.orgId, domain, objectType, true);
      const hit = reconcileValue(proposedSubtype, known, 0.6);
      subtype = hit ? hit.value : slugify(proposedSubtype);
      taxonomy.push({
        kind: "subtype",
        proposed: proposedSubtype,
        value: subtype,
        status: hit ? "approved" : settings.intelligence.taxonomyAutoApprove ? "approved" : "proposed",
        ...(hit && hit.value !== slugify(proposedSubtype) ? { reconciledFrom: slugify(proposedSubtype), similarity: hit.similarity } : {}),
      });
    }
  }
  log.push({ stage: "taxonomy", decision: taxonomy.some((t) => t.status === "proposed") ? "propose" : "reuse", input: { domain: c.domain, type: c.object_type, subtype: proposedSubtype }, output: { domain, objectType, subtype, taxonomy } });

  // Content dimensions only for content knowledge.
  const isContent = domain === "content" || typesFor("playbook", "content").some((t) => t.contentOnly && t.id === objectType);
  const content = c.content ?? null;

  const isHistorical = !!c.is_historical || bucket === "historical_archive";
  const status = isHistorical ? "historical" : "active";
  const founderEndorsement: FounderEndorsement | null = cls === "playbook" || cls === "platform_intelligence" ? "interested" : null;
  const evidenceLevel =
    cls === "playbook" || cls === "platform_intelligence"
      ? "source_teaching"
      : cls === "organizational_learning"
        ? "internal_data"
        : hints.isFounderVoice || domain === "founder" || bucket === "founder_brain"
          ? "founder_experience"
          : bucket === "company_truth" || bucket === "brand_voice"
            ? "verified_truth"
            : "internal_data";

  const sourcePlatform = cleanNull(hints.sourcePlatform) ?? pickAllowed(c.source?.platform, [...PLATFORMS, "book", "course", "article", "newsletter", "internal"]) ?? cleanNull(c.source?.platform);
  const draftBase = {
    intelligence_class: cls,
    domain,
    object_type: objectType,
    status,
    founder_endorsement: founderEndorsement,
    internal_validation: "unvalidated",
    source_platform: sourcePlatform,
    bucket,
  };
  const authority = defaultAuthority(draftBase);

  const draft: ObjectDraft = {
    ref: "",
    name: clean(c.name) || clean(input.title) || "Untitled",
    intelligence_class: cls,
    domain,
    object_type: objectType,
    subtype,
    status,
    priority: c.priority ?? "normal",
    founder_endorsement: founderEndorsement,
    implementation_status: "not_tested",
    internal_validation: "unvalidated",
    evidence_level: evidenceLevel,
    authority,
    applies_to: labelList(c.applies_to, 8),
    goals: labelList(c.goals, 6),
    business_functions: labelList(c.business_functions, 6),
    applies_to_platforms: slugList(c.applies_to_platforms).map((p) => pickAllowed(p, PLATFORMS) ?? p),
    tags: Array.from(new Set([...slugList(hints.tags ?? [], 20), ...slugList(c.tags, 20)])).filter((t) => t.length <= 40).slice(0, 20),
    content_format: isContent ? pickAllowed(content?.format, FORMATS) : null,
    content_job: isContent ? pickAllowed(content?.content_job, CONTENT_JOBS) : null,
    funnel_stage: isContent ? pickAllowed(content?.funnel_stage, FUNNEL_STAGES) : null,
    brand: isContent ? pickAllowed(content?.brand, BRANDS) : null,
    audiences: isContent ? labelList(content?.audiences ?? [], 8) : [],
    content_length: isContent ? pickAllowed(content?.length, LENGTHS) : null,
    source_expert: cleanNull(hints.sourceExpert) ?? cleanNull(c.source?.expert),
    source_type: cleanNull(hints.sourceType) ?? cleanNull(c.source?.type),
    source_platform: sourcePlatform,
    source_url: cleanNull(hints.sourceUrl) ?? cleanNull(c.source?.url),
    source_date: dateOnly(hints.sourceDate) ?? dateOnly(c.source?.date),
    source_claims: (c.source_claims ?? []).slice(0, 30).map((s) => ({ claim: s.claim, kind: s.kind, verifiable: s.verifiable })),
    effective_from: isoDate(c.effective_from),
    effective_until: isoDate(c.effective_until),
    summary: clean(c.summary),
    teaching_core: clean(c.teaching_core) || input.text.slice(0, 24000),
    sections: [],
    compiled_markdown: "",
    bucket,
  };
  return { draft, taxonomy, warnings };
}

/** Apply reviewed human edits over a draft. */
function applyOverrides(draft: ObjectDraft, o: DraftOverrides | null | undefined): ObjectDraft {
  if (!o) return draft;
  const d: ObjectDraft = { ...draft };
  const setStr = <K extends keyof ObjectDraft>(k: K, v: unknown) => {
    const rec = d as unknown as Record<string, unknown>;
    if (typeof v === "string") rec[k as string] = v.trim();
    else if (v === null) rec[k as string] = null;
  };
  if (o.name) d.name = o.name.trim();
  if (o.domain && isDomain(o.domain)) d.domain = o.domain;
  if (o.object_type) d.object_type = slugify(o.object_type);
  if (o.subtype !== undefined) d.subtype = o.subtype ? slugify(o.subtype) : null;
  if (o.status) d.status = o.status;
  if (o.priority) d.priority = o.priority;
  if (o.founder_endorsement !== undefined) d.founder_endorsement = o.founder_endorsement;
  if (o.implementation_status) d.implementation_status = o.implementation_status;
  if (o.internal_validation) d.internal_validation = o.internal_validation;
  if (o.evidence_level !== undefined) d.evidence_level = o.evidence_level;
  if (o.authority) d.authority = o.authority;
  if (o.applies_to) d.applies_to = slugList(o.applies_to, 20);
  if (o.goals) d.goals = slugList(o.goals, 20);
  if (o.business_functions) d.business_functions = slugList(o.business_functions, 20);
  if (o.applies_to_platforms) d.applies_to_platforms = slugList(o.applies_to_platforms, 20);
  if (o.tags) d.tags = slugList(o.tags, 30);
  if (o.audiences) d.audiences = slugList(o.audiences, 20);
  setStr("content_format", o.content_format);
  setStr("content_job", o.content_job);
  setStr("funnel_stage", o.funnel_stage);
  setStr("brand", o.brand);
  setStr("content_length", o.content_length);
  setStr("source_expert", o.source_expert);
  setStr("source_type", o.source_type);
  setStr("source_platform", o.source_platform);
  setStr("source_url", o.source_url);
  if (o.source_date !== undefined) d.source_date = dateOnly(o.source_date);
  if (o.effective_from !== undefined) d.effective_from = isoDate(o.effective_from);
  if (o.effective_until !== undefined) d.effective_until = isoDate(o.effective_until);
  if (typeof o.summary === "string") d.summary = o.summary.trim();
  if (o.sections && o.sections.length) d.sections = o.sections;
  if (o.compiled_markdown && o.compiled_markdown.trim()) {
    d.compiled_markdown = o.compiled_markdown;
    const parts = splitSections(o.compiled_markdown);
    if (parts.sections.length) d.sections = parts.sections;
  }
  // Governance edits can change authority unless the reviewer set it explicitly.
  if (!o.authority) d.authority = defaultAuthority({ ...d, bucket: d.bucket });
  return d;
}

// ---------------------------------------------------------------------------
// Stage 3 — dedup (NEW / ENRICH / DUPLICATE / CONFLICT)
// ---------------------------------------------------------------------------

async function dedupStage(
  db: SupabaseClient,
  input: CompileInput,
  draft: ObjectDraft,
  embedding: number[],
  settings: RagSettings,
  prompt: string,
  log: DecisionEntry[]
): Promise<{ dedup: CompilePreview["dedup"]; neighbors: ObjectMatch[]; model: string | null }> {
  const none: CompilePreview["dedup"] = { decision: "new", targetRef: null, targetId: null, targetName: null, similarity: null, rationale: "", enrichment: [], conflictSummary: null };
  const neighbors = await matchObjects(db, input.orgId, embedding, { classes: [draft.intelligence_class], count: 6 });
  if (neighbors.length === 0 || input.forceNew) {
    log.push({ stage: "dedup", decision: input.forceNew ? "forced_new" : "new", input: { neighbors: neighbors.length }, output: { top: neighbors[0]?.similarity ?? null } });
    return { dedup: none, neighbors, model: null };
  }

  // Explicit reviewer choice wins.
  if (input.dedupTargetRef) {
    const t = await getObjectByRef(db, input.orgId, input.dedupTargetRef);
    if (t) {
      const sim = neighbors.find((n) => n.id === t.id)?.similarity ?? null;
      return { dedup: { ...none, decision: "enrich", targetRef: t.ref, targetId: t.id, targetName: t.name, similarity: sim, rationale: "Reviewer selected the target." }, neighbors, model: null };
    }
  }

  const top = neighbors[0];
  if (top.similarity < settings.intelligence.dedupThreshold) {
    log.push({ stage: "dedup", decision: "new", input: { topRef: top.ref, similarity: top.similarity, threshold: settings.intelligence.dedupThreshold }, output: {} });
    return { dedup: none, neighbors, model: null };
  }

  // Judge against the top 3 with excerpts of their compiled markdown.
  const cands = neighbors.slice(0, 3);
  const withMd = await Promise.all(cands.map((n) => getObject(db, input.orgId, n.id, true)));
  const existingBlock = cands
    .map((n, i) => {
      const md = withMd[i]?.compiled_markdown ?? "";
      const body = md.replace(/^---[\s\S]*?---\s*/, "").slice(0, 2500);
      return `EXISTING ${n.ref} — ${n.name} (${n.intelligence_class}/${n.domain}/${n.object_type}/${n.subtype ?? "-"}; similarity ${n.similarity.toFixed(2)})\nSummary: ${n.summary ?? ""}\n${body}`;
    })
    .join("\n\n=====\n\n");
  const candidateBlock = `CANDIDATE — ${draft.name} (${draft.intelligence_class}/${draft.domain}/${draft.object_type}/${draft.subtype ?? "-"})\nSummary: ${draft.summary}\nCore:\n${draft.teaching_core.slice(0, 4000)}`;

  const started = Date.now();
  const res = await structured({
    tier: settings.intelligence.classifyTier,
    system: prompt,
    prompt: `${candidateBlock}\n\n=====\n\n${existingBlock}\n\nDecide: new | enrich | duplicate | conflict. If enrich, list the exact additions (heading + body) to add to the existing object. If conflict, summarise the disagreement.`,
    schema: DedupSchema,
    maxTokens: 3000,
  });
  if (!res) {
    log.push({ stage: "dedup", decision: "new", input: { topRef: top.ref, similarity: top.similarity }, output: { note: "judge unavailable → new" }, durationMs: Date.now() - started });
    return { dedup: none, neighbors, model: null };
  }
  const o = res.object;
  const target = cands.find((n) => n.ref === (o.target_ref ?? "").trim().toUpperCase()) ?? (o.decision !== "new" ? top : null);
  const dedup: CompilePreview["dedup"] = {
    decision: o.decision,
    targetRef: target?.ref ?? null,
    targetId: target?.id ?? null,
    targetName: target?.name ?? null,
    similarity: target?.similarity ?? top.similarity,
    rationale: o.rationale,
    enrichment: (o.enrichment?.additions ?? []).filter((a) => a.heading && a.body).slice(0, 8),
    conflictSummary: o.conflict_summary ?? null,
  };
  log.push({ stage: "dedup", decision: o.decision, input: { topRef: top.ref, similarity: top.similarity, candidates: cands.map((c) => c.ref) }, output: dedup, model: res.model, confidence: o.confidence ?? null, durationMs: Date.now() - started });
  return { dedup, neighbors, model: res.model };
}

// ---------------------------------------------------------------------------
// Stage 4 — compile the canonical markdown
// ---------------------------------------------------------------------------

async function compileStage(
  input: CompileInput,
  draft: ObjectDraft,
  settings: RagSettings,
  prompt: string,
  log: DecisionEntry[]
): Promise<{ sections: MarkdownSection[]; model: string | null }> {
  const cls = draft.intelligence_class;
  const meta = {
    class: cls,
    domain: draft.domain,
    type: draft.object_type,
    subtype: draft.subtype,
    name: draft.name,
    applies_to: draft.applies_to,
    goals: draft.goals,
    source: { expert: draft.source_expert, type: draft.source_type, platform: draft.source_platform, date: draft.source_date },
    source_claims: draft.source_claims,
    bucket: draft.bucket,
    learning: input.hints?.learning ?? null,
  };
  const started = Date.now();
  const res = await structured({
    tier: settings.intelligence.compileTier,
    system: prompt,
    prompt: `TEMPLATE: ${classTemplateName(cls)}\n\nMETADATA:\n${JSON.stringify(meta, null, 2)}\n\nSUMMARY:\n${draft.summary}\n\nSUBSTANCE (the extracted teaching / content — compile from THIS, never invent beyond it):\n${draft.teaching_core.slice(0, 14_000)}`,
    schema: CompileSchema,
    maxTokens: 8000,
  });
  if (res) {
    const sections = res.object.sections.map((s) => ({ heading: s.heading.replace(/^#+\s*/, "").replace(/^\d+\.\s*/, "").trim(), body: s.body.trim() })).filter((s) => s.heading && s.body);
    log.push({ stage: "compile", decision: "llm", input: { chars: draft.teaching_core.length }, output: { sections: sections.map((s) => s.heading) }, model: res.model, durationMs: Date.now() - started });
    return { sections, model: res.model };
  }
  const sections = fallbackSections(cls, draft.summary, draft.teaching_core);
  log.push({ stage: "compile", decision: "fallback", input: { chars: draft.teaching_core.length }, output: { sections: sections.map((s) => s.heading) }, durationMs: Date.now() - started });
  return { sections, model: null };
}

function finalizeMarkdown(draft: ObjectDraft, ref: string): string {
  const fm = buildFrontmatter({ ...draft, ref, version: 1 });
  return assembleMarkdown(fm, draft.name, draft.sections);
}

// ---------------------------------------------------------------------------
// User-supplied canonical markdown (skips classify + compile)
// ---------------------------------------------------------------------------

function draftFromMarkdown(input: CompileInput, md: string): { draft: ObjectDraft; relationships: { ref: string; type: string }[] } | null {
  const { data } = parseFrontmatter(md);
  const parts = splitSections(md);
  const cls = (typeof data.class === "string" && data.class) as IntelligenceClass | false;
  if (!cls || !parts.sections.length) return null;
  const domain = isDomain(String(data.domain ?? "")) ? String(data.domain) : "other";
  const objectType = slugify(String(data.type ?? "")) || defaultTypeFor(cls, domain);
  const src = (data.source ?? {}) as Record<string, unknown>;
  const list = (v: unknown) => slugList(Array.isArray(v) ? v : typeof v === "string" ? [v] : []);
  const rel: { ref: string; type: string }[] = [];
  if (Array.isArray(data.related_objects)) {
    for (const r of data.related_objects as Record<string, unknown>[]) {
      const ref = clean(r?.id).toUpperCase();
      const type = slugify(clean(r?.relationship) || "related_to");
      if (ref && isRelationshipType(type)) rel.push({ ref, type });
    }
  }
  const bucket = input.bucket ?? null;
  const base = {
    intelligence_class: cls,
    domain,
    object_type: objectType,
    status: typeof data.status === "string" ? data.status : "active",
    founder_endorsement: (typeof data.founder_endorsement === "string" ? data.founder_endorsement : cls === "playbook" ? "interested" : null) as FounderEndorsement | null,
    internal_validation: typeof data.internal_validation === "string" ? data.internal_validation : "unvalidated",
    source_platform: cleanNull(src.platform),
    bucket,
  };
  const draft: ObjectDraft = {
    ref: typeof data.id === "string" ? data.id.toUpperCase() : "",
    name: parts.title || clean(data.name) || clean(input.title) || "Untitled",
    intelligence_class: cls,
    domain,
    object_type: objectType,
    subtype: slugify(clean(data.subtype)) || null,
    status: base.status,
    priority: (["core", "strong", "normal", "low"].includes(String(data.priority)) ? String(data.priority) : "normal") as Priority,
    founder_endorsement: base.founder_endorsement,
    implementation_status: typeof data.implementation_status === "string" ? data.implementation_status : "not_tested",
    internal_validation: base.internal_validation,
    evidence_level: cleanNull(data.evidence_level) ?? (cls === "playbook" ? "source_teaching" : "internal_data"),
    authority: typeof data.authority === "string" && data.authority ? String(data.authority) : defaultAuthority(base),
    applies_to: list(data.applies_to),
    goals: list(data.goals),
    business_functions: list(data.business_functions),
    applies_to_platforms: list(data.applies_to_platforms ?? data.applies_to_platform),
    tags: list(data.tags),
    content_format: null,
    content_job: null,
    funnel_stage: null,
    brand: null,
    audiences: [],
    content_length: null,
    source_expert: cleanNull(src.expert),
    source_type: cleanNull(src.type),
    source_platform: cleanNull(src.platform),
    source_url: cleanNull(src.url),
    source_date: dateOnly(src.date),
    source_claims: [],
    effective_from: isoDate(data.effective_from),
    effective_until: isoDate(data.effective_until),
    summary: parts.sections.find((s) => /definition|summary|context/i.test(s.heading))?.body.slice(0, 600) ?? parts.sections[0].body.slice(0, 600),
    teaching_core: parts.sections.map((s) => `${s.heading}\n${s.body}`).join("\n\n").slice(0, 24000),
    sections: parts.sections,
    compiled_markdown: "",
    bucket,
  };
  return { draft, relationships: rel };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function compileKnowledge(db: SupabaseClient, input: CompileInput): Promise<CompileResult> {
  const log: DecisionEntry[] = [];
  const warnings: string[] = [];
  const { settings } = await loadSettings(input.orgId, db);
  const prompts = await getActivePrompts(input.orgId, ["knowledge_classify", "knowledge_compile", "dedup_judge"]);
  const write = input.mode === "commit";

  const empty: CompileResult = {
    mode: input.mode,
    blocked: null,
    draft: null as unknown as ObjectDraft,
    entities: [],
    keyConcepts: [],
    taxonomy: [],
    neighbors: [],
    dedup: { decision: "new", targetRef: null, targetId: null, targetName: null, similarity: null, rationale: "", enrichment: [], conflictSummary: null },
    suggestedRelationships: [],
    markdownRelationships: [],
    models: {},
    warnings,
    object: null,
    documentId: null,
    rawDocumentId: null,
    chunks: 0,
    target: null,
    log,
  };

  if (!input.text || !input.text.trim()) {
    return { ...empty, blocked: { reason: "No source text." } };
  }

  // ---- Guard: Company Truth cannot come directly from an external source ----
  const hintedPlatform = slugify(input.hints?.sourcePlatform ?? "");
  if (input.bucket === "company_truth" && !input.confirmTruth && hintedPlatform && EXTERNAL_SOURCE_PLATFORMS.has(hintedPlatform)) {
    log.push({ stage: "guard", decision: "blocked_company_truth", input: { platform: hintedPlatform }, output: {} });
    return {
      ...empty,
      blocked: { reason: `An external ${hintedPlatform} source cannot establish Company Truth directly. Save it as a Playbook or Founder Brain, or confirm you are recording verified company information.` },
    };
  }

  // ---- Stages 1–4 (or reuse a reviewed preview) ----
  let draft: ObjectDraft;
  let entities: EntityInput[] = [];
  let keyConcepts: string[] = [];
  let taxonomy: TaxonomyOutcome[] = [];
  let neighbors: ObjectMatch[] = [];
  let dedup = empty.dedup;
  let suggested: SuggestedRelationship[] = [];
  let markdownRelationships: { ref: string; type: string }[] = [];
  const models: CompilePreview["models"] = {};
  let embedding: number[] = [];

  if (input.preview) {
    // Commit from a reviewed preview: trust its AI output, apply human edits.
    draft = applyOverrides(input.preview.draft, input.overrides);
    entities = input.preview.entities;
    keyConcepts = input.preview.keyConcepts;
    taxonomy = input.preview.taxonomy;
    neighbors = input.preview.neighbors;
    dedup = input.dedupTargetRef
      ? { ...input.preview.dedup, decision: input.forceNew ? "new" : "enrich", targetRef: input.dedupTargetRef }
      : input.forceNew
        ? { ...input.preview.dedup, decision: "new" }
        : input.preview.dedup;
    suggested = input.preview.suggestedRelationships;
    markdownRelationships = input.preview.markdownRelationships;
    Object.assign(models, input.preview.models);
    warnings.push(...input.preview.warnings);
    // Persist taxonomy proposals now (preview never writes).
    if (draft.subtype) {
      const r = await ensureTaxonomyValue(
        db,
        input.orgId,
        { kind: "subtype", value: draft.subtype, intelligenceClass: draft.intelligence_class, domain: draft.domain, objectType: draft.object_type, proposedBy: input.overrides?.subtype ? "user" : "ai", autoApprove: settings.intelligence.taxonomyAutoApprove },
        suggestedSubtypes(draft.domain, draft.object_type)
      );
      draft.subtype = r.value || draft.subtype;
    }
    if (!draft.sections.length) draft.sections = fallbackSections(draft.intelligence_class, draft.summary, draft.teaching_core);
  } else {
    // User-supplied canonical markdown?
    const fromMd = /^---\r?\n[\s\S]*?\r?\n---/.test(input.text.trimStart()) ? draftFromMarkdown(input, input.text.trim()) : null;
    if (fromMd) {
      draft = fromMd.draft;
      markdownRelationships = fromMd.relationships;
      if (draft.subtype) {
        if (write) {
          const r = await ensureTaxonomyValue(db, input.orgId, { kind: "subtype", value: draft.subtype, intelligenceClass: draft.intelligence_class, domain: draft.domain, objectType: draft.object_type, proposedBy: "user", autoApprove: true }, suggestedSubtypes(draft.domain, draft.object_type));
          draft.subtype = r.value || draft.subtype;
          taxonomy.push({ kind: "subtype", proposed: draft.subtype, value: r.value, status: r.status, reconciledFrom: r.reconciledFrom, similarity: r.similarity });
        }
      }
      log.push({ stage: "classify", decision: "markdown_frontmatter", input: { ref: draft.ref }, output: { domain: draft.domain, type: draft.object_type, subtype: draft.subtype } });
    } else {
      const { c, model } = await classifyStage(db, input, settings, prompts.knowledge_classify, log);
      if (model) models.classify = model;
      const d = await draftFromClassification(db, input, c, settings, write, log);
      draft = d.draft;
      taxonomy = d.taxonomy;
      warnings.push(...d.warnings);
      entities = (c.entities ?? []).map((e) => ({ kind: slugify(e.kind), name: e.name, role: e.role ?? null, value: e.value ?? null })).filter((e) => e.name);
      keyConcepts = (c.key_concepts ?? []).slice(0, 12);
      for (const h of c.relationship_hints ?? []) {
        const type = slugify(h.relationship);
        if (h.ref_or_name && isRelationshipType(type)) markdownRelationships.push({ ref: h.ref_or_name.trim().toUpperCase(), type });
      }
    }
    draft = applyOverrides(draft, input.overrides);

    // Dedup on the object-level embedding of the candidate.
    embedding = await embed(objectEmbeddingText(draft.name, draft.summary, draft.sections.length ? draft.sections : [{ heading: "Core", body: draft.teaching_core.slice(0, 2500) }]));
    const dd = await dedupStage(db, input, draft, embedding, settings, prompts.dedup_judge, log);
    dedup = dd.dedup;
    neighbors = dd.neighbors;
    if (dd.model) models.dedup = dd.model;

    // Compile the canonical sections (unless the source already was canonical).
    // Business Reality / learning sources with their own structure (or long ones)
    // are PRESERVED verbatim — reality is evidence, not something to rewrite —
    // which also costs nothing. Playbooks and platform intelligence are normalised
    // by the compile model; if that fails, fall back to the preserved structure.
    if (!draft.sections.length && dedup.decision !== "duplicate" && dedup.decision !== "enrich") {
      const preserve =
        (draft.intelligence_class === "business_reality" || draft.intelligence_class === "organizational_learning") &&
        shouldPreserveStructure(input.text);
      if (preserve) {
        draft.sections = preserveSections(draft, input.text, entities);
        log.push({ stage: "compile", decision: "preserved_structure", input: { chars: input.text.length }, output: { sections: draft.sections.map((s) => s.heading) } });
      } else {
        const cs = await compileStage(input, draft, settings, prompts.knowledge_compile, log);
        draft.sections = cs.model ? cs.sections : preserveSections(draft, input.text, entities);
        if (cs.model) models.compile = cs.model;
      }
    }

    // AI relationship suggestions from the neighbourhood (not the dedup target).
    suggested = neighbors
      .filter((n) => n.id !== dedup.targetId && n.similarity >= settings.intelligence.suggestThreshold)
      .slice(0, 5)
      .map((n) => ({
        targetId: n.id,
        targetRef: n.ref,
        targetName: n.name,
        type: n.domain === draft.domain && n.object_type === draft.object_type ? "complements" : "related_to",
        confidence: Number(n.similarity.toFixed(3)),
        reason: `Semantically similar (${Math.round(n.similarity * 100)}%) ${n.intelligence_class}/${n.domain}/${n.object_type}.`,
      }));
    if (suggested.length) log.push({ stage: "relationships", decision: "suggest", input: {}, output: suggested });
  }

  if (!draft.sections.length) draft.sections = fallbackSections(draft.intelligence_class, draft.summary, draft.teaching_core);
  const prefix = refPrefix(draft);
  draft.ref = draft.ref || `${prefix}-…`;
  draft.compiled_markdown = draft.compiled_markdown && input.overrides?.compiled_markdown ? draft.compiled_markdown : finalizeMarkdown(draft, draft.ref);

  const preview: CompileResult = {
    ...empty,
    draft,
    entities,
    keyConcepts,
    taxonomy,
    neighbors,
    dedup,
    suggestedRelationships: suggested,
    markdownRelationships,
    models,
    warnings,
  };
  if (!write) return preview;

  // =========================================================================
  // COMMIT
  // =========================================================================
  const orgId = input.orgId;
  const storeRaw = input.storeRaw ?? (draft.intelligence_class === "playbook" || draft.intelligence_class === "platform_intelligence");
  const createdBy = input.createdBy ?? null;
  const newSource: SourceRecord = {
    expert: draft.source_expert,
    type: draft.source_type,
    platform: draft.source_platform,
    url: draft.source_url,
    date: draft.source_date,
    added_at: new Date().toISOString(),
  };

  // ---- DUPLICATE: only provenance on the existing object ----
  if (dedup.decision === "duplicate" && dedup.targetId) {
    const target = await getObject(db, orgId, dedup.targetId, false);
    if (target) {
      let rawDocumentId: string | null = null;
      if (storeRaw) rawDocumentId = await storeRawSource(db, input, draft, target.id, log);
      const sources = [...(target.sources ?? []), { ...newSource, document_id: rawDocumentId, note: "duplicate source" }];
      await db.from("knowledge_objects").update({ sources }).eq("id", target.id).eq("org_id", orgId);
      await logDecision(db, orgId, { runId: input.runId, objectId: target.id, stage: "persist", decision: "duplicate_provenance", input: { ref: target.ref }, output: newSource });
      await flushLog(db, orgId, input.runId ?? null, target.id, log);
      return { ...preview, target, rawDocumentId, chunks: 0 };
    }
  }

  // ---- ENRICH: append to the existing object, re-chunk it ----
  if (dedup.decision === "enrich" && dedup.targetId) {
    const target = await getObject(db, orgId, dedup.targetId, true);
    if (target) {
      const additions = (dedup.enrichment.length ? dedup.enrichment : draft.sections).slice(0, 8);
      const label = [draft.source_expert, draft.source_platform, draft.source_date].filter(Boolean).join(" · ") || draft.name;
      const existing = target.compiled_markdown ?? "";
      const parts = splitSections(existing);
      const merged: MarkdownSection[] = [...parts.sections];
      for (const a of additions) {
        // Merge into a same-named section when present; else append as an enrichment section.
        const idx = merged.findIndex((s) => s.heading.toLowerCase() === a.heading.toLowerCase());
        if (idx >= 0) merged[idx] = { heading: merged[idx].heading, body: `${merged[idx].body}\n\n**Added from ${label}:** ${a.body}` };
        else merged.push({ heading: `${a.heading} (from ${label})`, body: a.body });
      }
      const sources = [...(target.sources ?? []), { ...newSource, note: "enrichment" }];
      const version = (target.version ?? 1) + 1;
      const fm = buildFrontmatter({ ...target, sources, version });
      const md = assembleMarkdown(fm, parts.title || target.name, merged);
      const contextPrefix = objectContextLine(target);
      let chunks = 0;
      let rawDocumentId: string | null = null;
      if (target.document_id) {
        const r = await reingestDocument(db, {
          orgId,
          documentId: target.document_id,
          text: md,
          title: target.name,
          metadata: { object_version: version },
          chunkStrategy: "knowledge_object",
          contextPrefix,
          intelligenceClass: target.intelligence_class,
          domain: target.domain,
          objectId: target.id,
        });
        chunks = r.chunks;
      }
      if (storeRaw) rawDocumentId = await storeRawSource(db, input, draft, target.id, log);
      const objEmbedding = await embed(objectEmbeddingText(target.name, target.summary, merged));
      await db
        .from("knowledge_objects")
        .update({
          compiled_markdown: md,
          sources: rawDocumentId ? sources.map((s, i) => (i === sources.length - 1 ? { ...s, document_id: rawDocumentId } : s)) : sources,
          version,
          ...(objEmbedding.some((v) => v !== 0) ? { embedding: objEmbedding } : {}),
          tags: Array.from(new Set([...(target.tags ?? []), ...draft.tags])).slice(0, 40),
        })
        .eq("id", target.id)
        .eq("org_id", orgId);
      await upsertEntityMentions(db, orgId, entities, { objectId: target.id, documentId: target.document_id });
      await logDecision(db, orgId, { runId: input.runId, objectId: target.id, stage: "persist", decision: "enriched", input: { ref: target.ref, additions: additions.map((a) => a.heading) }, output: { version, chunks } });
      await flushLog(db, orgId, input.runId ?? null, target.id, log);
      const updated = await getObject(db, orgId, target.id, false);
      return { ...preview, target: updated ?? target, documentId: target.document_id, rawDocumentId, chunks };
    }
  }

  // ---- NEW (also CONFLICT: new + contradicts edges) ----
  const ref = await nextRef(db, orgId, prefix);
  draft.ref = ref;
  draft.compiled_markdown = input.overrides?.compiled_markdown?.trim() ? input.overrides.compiled_markdown : finalizeMarkdown(draft, ref);

  const { data: inserted, error: insErr } = await db
    .from("knowledge_objects")
    .insert({
      org_id: orgId,
      ref,
      name: draft.name,
      intelligence_class: draft.intelligence_class,
      domain: draft.domain,
      object_type: draft.object_type,
      subtype: draft.subtype,
      status: draft.status,
      priority: draft.priority,
      founder_endorsement: draft.founder_endorsement,
      implementation_status: draft.implementation_status,
      internal_validation: draft.internal_validation,
      evidence_level: draft.evidence_level,
      authority: draft.authority,
      applies_to: draft.applies_to,
      goals: draft.goals,
      business_functions: draft.business_functions,
      applies_to_platforms: draft.applies_to_platforms,
      tags: draft.tags,
      content_format: draft.content_format,
      content_job: draft.content_job,
      funnel_stage: draft.funnel_stage,
      brand: draft.brand,
      audiences: draft.audiences,
      content_length: draft.content_length,
      source_expert: draft.source_expert,
      source_type: draft.source_type,
      source_platform: draft.source_platform,
      source_url: draft.source_url,
      source_date: draft.source_date,
      source_claims: draft.source_claims,
      sources: [newSource],
      effective_from: draft.effective_from,
      effective_until: draft.effective_until,
      last_verified_at: draft.bucket === "company_truth" ? new Date().toISOString() : null,
      version: 1,
      compiled_markdown: draft.compiled_markdown,
      summary: draft.summary,
      attributes: { bucket: draft.bucket, key_concepts: keyConcepts },
      created_by: createdBy,
    })
    .select(OBJECT_COLUMNS)
    .single();
  if (insErr || !inserted) throw new Error(insErr?.message ?? "knowledge object insert failed");
  const object = inserted as unknown as KnowledgeObjectRow;

  try {
    // Compiled document (the retrievable object) — semantic chunks with identity.
    const contextPrefix = objectContextLine(object);
    const doc = await ingestOne(db, {
      orgId,
      sourceType: "document",
      title: draft.name,
      text: draft.compiled_markdown,
      metadata: {
        is_knowledge_object: true,
        object_id: object.id,
        object_ref: ref,
        intelligence_class: draft.intelligence_class,
        domain: draft.domain,
        object_type: draft.object_type,
        subtype: draft.subtype,
        authority: draft.authority,
        founder_endorsement: draft.founder_endorsement,
        priority: draft.priority,
        status: draft.status,
        effective_from: draft.effective_from,
        effective_until: draft.effective_until,
        tags: draft.tags,
        category: draft.bucket ?? undefined,
        uploaded_by: createdBy ?? undefined,
      },
      intelligenceClass: draft.intelligence_class,
      domain: draft.domain,
      objectId: object.id,
      chunkStrategy: "knowledge_object",
      contextPrefix,
      allowDuplicate: true,
    });

    // Raw source (separately identifiable, low authority, raw lane).
    let rawDocumentId: string | null = null;
    if (storeRaw && !/^---\r?\n/.test(input.text.trimStart())) {
      rawDocumentId = await storeRawSource(db, input, draft, object.id, log);
    }

    // Object-level embedding for future dedup / suggestions.
    const objEmbedding = embedding.some((v) => v !== 0) ? embedding : await embed(objectEmbeddingText(draft.name, draft.summary, draft.sections));
    await db
      .from("knowledge_objects")
      .update({
        document_id: doc.documentId,
        raw_document_id: rawDocumentId,
        ...(objEmbedding.some((v) => v !== 0) ? { embedding: objEmbedding } : {}),
        sources: [{ ...newSource, document_id: rawDocumentId }],
      })
      .eq("id", object.id)
      .eq("org_id", orgId);

    // Entities.
    if (entities.length) {
      await upsertEntityMentions(db, orgId, entities, { objectId: object.id, documentId: doc.documentId });
      log.push({ stage: "entities", decision: "upsert", input: {}, output: { count: entities.length } });
    }

    // Relationships: markdown-declared (confirmed), conflict (confirmed, both ways), AI suggestions (suggested).
    for (const r of markdownRelationships) {
      const t = await getObjectByRef(db, orgId, r.ref);
      if (t) await upsertRelationship(db, orgId, { sourceId: object.id, type: r.type, targetId: t.id, status: "confirmed", origin: "markdown" });
    }
    if (dedup.decision === "conflict" && dedup.targetId) {
      await upsertRelationship(db, orgId, { sourceId: object.id, type: "contradicts", targetId: dedup.targetId, status: "confirmed", origin: "system", note: dedup.conflictSummary ?? dedup.rationale });
      await upsertRelationship(db, orgId, { sourceId: dedup.targetId, type: "contradicts", targetId: object.id, status: "confirmed", origin: "system", note: dedup.conflictSummary ?? dedup.rationale });
    }
    for (const s of suggested) {
      await upsertRelationship(db, orgId, { sourceId: object.id, type: s.type, targetId: s.targetId, status: "suggested", origin: "ai", confidence: s.confidence, note: s.reason });
    }

    // Organizational Learning lifecycle row.
    if (draft.intelligence_class === "organizational_learning") {
      const L = input.hints?.learning ?? {};
      const recordType = ["decision", "implementation", "experiment", "result", "learning", "adaptation", "postmortem", "standard"].includes(draft.object_type) ? draft.object_type : "learning";
      await db.from("learning_records").insert({
        org_id: orgId,
        object_id: object.id,
        record_type: recordType,
        lifecycle_status: L.lifecycleStatus ?? (recordType === "decision" ? "open" : recordType === "implementation" ? "implementing" : recordType === "experiment" ? "measuring" : "completed"),
        department: L.department ?? null,
        owner: L.owner ?? null,
        changes: L.changes ?? {},
        metrics_before: L.metricsBefore ?? {},
        metrics_after: L.metricsAfter ?? {},
        confidence: L.confidence ?? null,
        related_playbook_refs: (L.relatedPlaybookRefs ?? []).map((r) => r.toUpperCase()),
        evidence_document_ids: L.evidenceDocumentIds ?? [],
        missing_evidence: L.missingEvidence ?? [],
        parent_record_id: L.parentRecordId ?? null,
        source: L.source ?? "manual",
        created_by: createdBy,
      }).then(({ error }) => error && console.error("[compiler] learning_records insert:", error.message), () => {});
      // System edges: learning → playbooks it used.
      for (const r of L.relatedPlaybookRefs ?? []) {
        const t = await getObjectByRef(db, orgId, r);
        if (t) {
          await upsertRelationship(db, orgId, { sourceId: object.id, type: "used_playbook", targetId: t.id, status: "confirmed", origin: "system" });
          await upsertRelationship(db, orgId, { sourceId: t.id, type: "implemented_in", targetId: object.id, status: "confirmed", origin: "system" });
        }
      }
    }

    await logDecision(db, orgId, { runId: input.runId, objectId: object.id, stage: "persist", decision: dedup.decision === "conflict" ? "new_conflict" : "new", input: { ref }, output: { documentId: doc.documentId, rawDocumentId, chunks: doc.chunks } });
    await flushLog(db, orgId, input.runId ?? null, object.id, log);

    const final = await getObject(db, orgId, object.id, false);
    return { ...preview, draft: { ...draft, ref }, object: final ?? object, documentId: doc.documentId, rawDocumentId, chunks: doc.chunks };
  } catch (e) {
    // Roll back the object row (edges/mentions cascade) so a failed embed never leaves a half-object.
    await db.from("knowledge_objects").delete().eq("id", object.id).eq("org_id", orgId);
    throw e;
  }
}

/** Store the raw source text as a raw_archive document linked to the object. */
async function storeRawSource(db: SupabaseClient, input: CompileInput, draft: ObjectDraft, objectId: string, log: DecisionEntry[]): Promise<string | null> {
  try {
    const r = await ingestOne(db, {
      orgId: input.orgId,
      sourceType: "document",
      title: `[raw] ${input.title || draft.name}`,
      text: input.text,
      uri: draft.source_url ?? null,
      metadata: {
        is_raw_source: true,
        object_id: objectId,
        source_expert: draft.source_expert ?? undefined,
        source_platform: draft.source_platform ?? undefined,
        source_type: draft.source_type ?? undefined,
        source_date: draft.source_date ?? undefined,
        uploaded_by: input.createdBy ?? undefined,
      },
      intelligenceClass: "raw_archive",
      domain: draft.domain,
      objectId,
      contextualize: false,
    });
    log.push({ stage: "persist", decision: r.skipped ? "raw_exists" : "raw_stored", input: {}, output: { documentId: r.documentId, chunks: r.chunks } });
    return r.documentId;
  } catch (e) {
    log.push({ stage: "persist", decision: "raw_failed", input: {}, output: { error: e instanceof Error ? e.message : String(e) } });
    return null;
  }
}

/** Persist the in-memory decision log (best-effort). */
async function flushLog(db: SupabaseClient, orgId: string, runId: string | null, objectId: string | null, log: DecisionEntry[]): Promise<void> {
  for (const e of log) await logDecision(db, orgId, { ...e, runId: e.runId ?? runId, objectId: e.objectId ?? objectId });
}
