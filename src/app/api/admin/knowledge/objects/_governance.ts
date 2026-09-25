// Governance edits for knowledge objects, shared by
//   PATCH /api/admin/knowledge/objects/[id]   one object (any metadata, markdown)
//   PATCH /api/admin/knowledge/objects        many objects (governance enums only)
// so both paths apply exactly the same rules: enum whitelist, default-authority
// recompute, frontmatter rebuild on a metadata-only change, an org-scoped update
// and a decision-log entry per object.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assembleMarkdown,
  buildFrontmatter,
  logDecision,
  splitSections,
  OBJECT_COLUMNS,
  OBJECT_COLUMNS_WITH_MARKDOWN,
  type KnowledgeObjectRow,
} from "@/lib/knowledge-store";
import {
  defaultAuthority,
  realityBucketOf,
  FOUNDER_ENDORSEMENTS,
  IMPLEMENTATION_STATUSES,
  INTERNAL_VALIDATIONS,
  PRIORITIES,
  OBJECT_STATUSES,
  EVIDENCE_LEVELS,
} from "@/lib/intelligence-taxonomy";
import { str, uuid } from "../_shared";

export type ObjectPatch = Record<string, unknown>;

export const GOVERNANCE_ENUMS = {
  status: OBJECT_STATUSES.map((s) => s.id),
  priority: PRIORITIES.map((p) => p.id),
  founder_endorsement: FOUNDER_ENDORSEMENTS.map((e) => e.id),
  implementation_status: IMPLEMENTATION_STATUSES.map((s) => s.id),
  internal_validation: INTERNAL_VALIDATIONS.map((v) => v.id),
  evidence_level: EVIDENCE_LEVELS.map((e) => e.id),
};

export const GOVERNANCE_ENUM_KEYS = [
  "status",
  "priority",
  "founder_endorsement",
  "implementation_status",
  "internal_validation",
  "evidence_level",
] as const;

/** Fields the default authority is derived from (see defaultAuthority). */
const AUTHORITY_INPUTS = ["status", "founder_endorsement", "internal_validation", "domain", "object_type"];

/**
 * Copy the valid governance enum values from `body` into `patch`. Unknown
 * values are ignored; `founder_endorsement: null` clears the endorsement.
 */
export function pickGovernanceEnums(body: Record<string, unknown>, patch: ObjectPatch): void {
  for (const k of GOVERNANCE_ENUM_KEYS) {
    const v = str(body[k], 40);
    if (v && (GOVERNANCE_ENUMS[k] as readonly string[]).includes(v)) patch[k] = v;
    else if (k === "founder_endorsement" && body[k] === null) patch[k] = null;
  }
}

/** Recompute the default authority when a field it depends on is in the patch. */
export function recomputeAuthority(current: KnowledgeObjectRow, patch: ObjectPatch): void {
  if (!Object.keys(patch).some((k) => AUTHORITY_INPUTS.includes(k))) return;
  const next = { ...current, ...patch } as KnowledgeObjectRow;
  patch.authority = defaultAuthority({ ...next, bucket: next.intelligence_class === "business_reality" ? realityBucketOf(next) : null });
}

/** A metadata change that appears in the compiled markdown's frontmatter. */
export function touchesFrontmatter(patch: ObjectPatch): boolean {
  return Boolean(
    patch.name ||
      patch.domain ||
      patch.object_type ||
      patch.subtype ||
      patch.authority ||
      patch.founder_endorsement !== undefined ||
      patch.status
  );
}

/**
 * Metadata-only change: keep the compiled markdown's frontmatter in sync (no
 * re-chunk, no re-embed) and carry a domain change onto the object's document
 * and chunks. Mutates `patch`.
 */
export async function syncMetadataOnly(
  db: SupabaseClient,
  orgId: string,
  current: KnowledgeObjectRow,
  patch: ObjectPatch
): Promise<void> {
  const nextMeta = { ...current, ...patch } as KnowledgeObjectRow;
  const parts = splitSections(current.compiled_markdown ?? "");
  if (parts.sections.length) patch.compiled_markdown = assembleMarkdown(buildFrontmatter(nextMeta), parts.title || nextMeta.name, parts.sections);
  if (current.document_id && patch.domain) {
    await db.from("documents").update({ domain: patch.domain }).eq("id", current.document_id).eq("org_id", orgId).then(() => {}, () => {});
    await db.from("chunks").update({ domain: patch.domain }).eq("object_id", current.id).eq("org_id", orgId).then(() => {}, () => {});
  }
}

/** Write the patch (org-scoped) and log who changed which fields. Returns the updated row. */
export async function persistObjectPatch(
  db: SupabaseClient,
  orgId: string,
  id: string,
  patch: ObjectPatch,
  opts: { decision: string; by: string; columns?: string }
): Promise<Record<string, unknown> | null> {
  const { data, error } = await db
    .from("knowledge_objects")
    .update(patch)
    .eq("id", id)
    .eq("org_id", orgId)
    .select(opts.columns ?? OBJECT_COLUMNS)
    .single();
  if (error) throw error;
  await logDecision(db, orgId, { objectId: id, stage: "persist", decision: opts.decision, input: { fields: Object.keys(patch) }, output: { by: opts.by } });
  return (data ?? null) as unknown as Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Bulk governance (PATCH /api/admin/knowledge/objects)
// ---------------------------------------------------------------------------

/** Most ids one bulk request accepts (the client sends ≤200 per request). */
export const BULK_MAX_IDS = 200;

/** Stop starting new objects after this long; the rest come back as `remaining` (maxDuration is 120s). */
export const BULK_TIME_BUDGET_MS = 80_000;

/** Objects loaded per query (each carries its compiled markdown for the frontmatter rebuild). */
const LOAD_BATCH = 25;

/** Objects updated at once inside a loaded batch. */
const POOL = 4;

/** Columns a bulk update returns per object: enough for the list to update its row in place. */
export const BULK_ROW_COLUMNS =
  "id, status, priority, founder_endorsement, implementation_status, internal_validation, evidence_level, authority, last_verified_at, updated_at";

/**
 * `ids` from a bulk request body: a non-empty array of at most `max` uuids,
 * deduped. Anything else is a 400 with a readable message.
 */
export function parseBulkIds(v: unknown, max = BULK_MAX_IDS): { ids: string[] } | { error: string } {
  if (!Array.isArray(v) || v.length === 0) return { error: "ids must be a non-empty array of ids" };
  if (v.length > max) return { error: `At most ${max} ids per request` };
  const ids = v.map((x) => uuid(x));
  if (ids.some((id) => !id)) return { error: "ids must be uuids" };
  return { ids: Array.from(new Set(ids)) };
}

/**
 * The governance fields a bulk request may set: status, priority, endorsement
 * (null clears it), implementation status, internal validation, evidence level,
 * and `verify_now: true` (stamps last_verified_at). Never names, markdown or
 * taxonomy: those stay single-object edits.
 */
export function bulkGovernancePatch(body: unknown): ObjectPatch {
  const patch: ObjectPatch = {};
  if (!body || typeof body !== "object" || Array.isArray(body)) return patch;
  const b = body as Record<string, unknown>;
  pickGovernanceEnums(b, patch);
  if (b.verify_now === true) patch.last_verified_at = new Date().toISOString();
  return patch;
}

/** One object's governance edit with the single-object side effects (authority, frontmatter, update, log). */
export async function applyGovernancePatch(
  db: SupabaseClient,
  orgId: string,
  current: KnowledgeObjectRow,
  base: ObjectPatch,
  by: string,
  columns = BULK_ROW_COLUMNS
): Promise<Record<string, unknown>> {
  const patch: ObjectPatch = { ...base };
  recomputeAuthority(current, patch);
  if (touchesFrontmatter(patch)) await syncMetadataOnly(db, orgId, current, patch);
  const row = await persistObjectPatch(db, orgId, current.id, patch, { decision: "governance_edited", by, columns });
  if (!row) throw new Error("Not found or already deleted");
  return row;
}

export interface BulkFailureOut {
  id: string;
  error: string;
  status?: number;
}

export interface BulkGovernanceResult {
  /** Ids updated, with their new governance fields in `objects`. */
  updated: string[];
  objects: Record<string, unknown>[];
  /** Not in this org (404) or the update failed. */
  failed: BulkFailureOut[];
  /** Not started because the time budget ran out: send them again. */
  remaining: string[];
}

function errorText(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === "string" && m ? m : "Update failed";
}

/**
 * Apply `patch` to every object in `ids` that belongs to `orgId`: loaded in
 * batches of 25, updated four at a time, each with the same side effects as
 * the single-object PATCH. Objects not started within the time budget come
 * back in `remaining`. Throws only when the very first load fails (e.g. the
 * migration is missing), so the caller can answer with dbError.
 */
export async function bulkApplyGovernance(
  db: SupabaseClient,
  orgId: string,
  ids: string[],
  patch: ObjectPatch,
  by: string,
  budgetMs = BULK_TIME_BUDGET_MS
): Promise<BulkGovernanceResult> {
  const started = Date.now();
  const overBudget = () => Date.now() - started > budgetMs;
  const out: BulkGovernanceResult = { updated: [], objects: [], failed: [], remaining: [] };

  for (let i = 0; i < ids.length; i += LOAD_BATCH) {
    const batch = ids.slice(i, i + LOAD_BATCH);
    if (overBudget()) {
      out.remaining.push(...ids.slice(i));
      break;
    }
    const { data, error } = await db
      .from("knowledge_objects")
      .select(OBJECT_COLUMNS_WITH_MARKDOWN)
      .eq("org_id", orgId)
      .in("id", batch);
    if (error) {
      if (i === 0) throw error;
      for (const id of batch) out.failed.push({ id, error: errorText(error) });
      continue;
    }
    const byId = new Map(((data ?? []) as unknown as KnowledgeObjectRow[]).map((o) => [o.id, o]));
    const found: KnowledgeObjectRow[] = [];
    for (const id of batch) {
      const row = byId.get(id);
      if (row) found.push(row);
      else out.failed.push({ id, error: "Not found", status: 404 });
    }

    let next = 0;
    const lane = async () => {
      for (;;) {
        const j = next++;
        if (j >= found.length) return;
        const current = found[j];
        if (overBudget()) {
          out.remaining.push(current.id);
          continue;
        }
        try {
          const row = await applyGovernancePatch(db, orgId, current, patch, by);
          out.updated.push(current.id);
          out.objects.push(row);
        } catch (e) {
          out.failed.push({ id: current.id, error: errorText(e) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(POOL, found.length) }, lane));
  }
  return out;
}
