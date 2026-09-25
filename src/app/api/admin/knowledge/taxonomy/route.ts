// /api/admin/knowledge/taxonomy — the controlled-but-extensible taxonomy.
//   GET   → predefined values (code) + org extensions/proposals (DB) + usage
//   POST  → create an approved value { kind, value, domain?, objectType?, label? }
//   PATCH → { id, action: "approve" | "reject" | "rename", value?, label? }
//   PATCH → { ids: uuid[] (1..200), action: "approve" | "reject" }   (bulk; rename
//           stays one value at a time) → { ok, updated, ids }

import { supabaseAdmin } from "@/lib/supabase";
import { BULK_MAX_IDS } from "@/lib/bulk";
import { ensureTaxonomyValue, listTaxonomyValues } from "@/lib/knowledge-store";
import {
  INTELLIGENCE_CLASSES,
  DOMAINS,
  OBJECT_TYPES,
  SUGGESTED_SUBTYPES,
  PLATFORMS,
  FORMATS,
  CONTENT_JOBS,
  FUNNEL_STAGES,
  BRANDS,
  AUDIENCES,
  APPLIES_TO,
  BUSINESS_FUNCTIONS,
  LENGTHS,
  REALITY_BUCKETS,
  RELATIONSHIP_TYPES,
  ENTITY_KINDS,
  AUTHORITY_LEVELS,
  FOUNDER_ENDORSEMENTS,
  IMPLEMENTATION_STATUSES,
  INTERNAL_VALIDATIONS,
  EVIDENCE_LEVELS,
  PRIORITIES,
  OBJECT_STATUSES,
  LEARNING_STATUSES,
  slugify,
  suggestedSubtypes,
} from "@/lib/intelligence-taxonomy";
import { guard, dbError, str, uuid } from "../_shared";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
// Bulk approve / reject is one set update: bounded DB work, far below this.
export const maxDuration = 60;

/** `ids` of a bulk request: 1..BULK_MAX_IDS uuids (deduped), or why not. */
function parseIds(v: unknown): { ids: string[] } | { error: string } {
  if (!Array.isArray(v) || v.length === 0) return { error: "ids must be a non-empty array of ids" };
  const ids = new Set<string>();
  for (const x of v) {
    const id = uuid(x);
    if (!id) return { error: "ids must be uuids" };
    ids.add(id);
  }
  if (ids.size > BULK_MAX_IDS) return { error: `At most ${BULK_MAX_IDS} ids per request` };
  return { ids: Array.from(ids) };
}

export async function GET() {
  const g = await guard();
  if ("response" in g) return g.response;
  const { admin } = g;
  const db = supabaseAdmin();
  const values = await listTaxonomyValues(db, admin.orgId, { includeProposed: true, includeRejected: true });
  // Usage of subtypes across objects (for the table's "used by" column).
  const usage: Record<string, number> = {};
  try {
    const { data } = await db.from("knowledge_objects").select("subtype, domain, object_type").eq("org_id", admin.orgId).not("subtype", "is", null).limit(5000);
    for (const r of (data ?? []) as { subtype: string; domain: string; object_type: string }[]) {
      const k = `${r.domain}/${r.object_type}/${r.subtype}`;
      usage[k] = (usage[k] ?? 0) + 1;
    }
  } catch {
    /* pre-migration */
  }
  return Response.json({
    predefined: {
      classes: INTELLIGENCE_CLASSES,
      domains: DOMAINS,
      types: OBJECT_TYPES,
      subtypes: SUGGESTED_SUBTYPES,
      platforms: PLATFORMS,
      formats: FORMATS,
      contentJobs: CONTENT_JOBS,
      funnelStages: FUNNEL_STAGES,
      brands: BRANDS,
      audiences: AUDIENCES,
      appliesTo: APPLIES_TO,
      businessFunctions: BUSINESS_FUNCTIONS,
      lengths: LENGTHS,
      buckets: REALITY_BUCKETS,
      relationshipTypes: RELATIONSHIP_TYPES,
      entityKinds: ENTITY_KINDS,
      authority: AUTHORITY_LEVELS,
      endorsements: FOUNDER_ENDORSEMENTS,
      implementation: IMPLEMENTATION_STATUSES,
      validation: INTERNAL_VALIDATIONS,
      evidence: EVIDENCE_LEVELS,
      priorities: PRIORITIES,
      statuses: OBJECT_STATUSES,
      learningStatuses: LEARNING_STATUSES,
    },
    values,
    usage,
  });
}

export async function POST(req: Request) {
  const g = await guard("documents:write");
  if ("response" in g) return g.response;
  const { admin } = g;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const kind = str(body.kind, 40);
  const value = str(body.value, 80);
  if (!kind || !value) return Response.json({ error: "kind and value are required" }, { status: 400 });
  const domain = str(body.domain, 40) || null;
  const objectType = str(body.objectType, 60) || null;
  // Reconcile against the PREDEFINED values too, so "Finance" reuses `finance`
  // instead of creating a near-duplicate custom domain.
  const known =
    kind === "domain" ? DOMAINS.map((d) => d.id)
    : kind === "object_type" ? OBJECT_TYPES.map((t) => t.id)
    : kind === "subtype" ? suggestedSubtypes(domain, objectType)
    : [];
  try {
    const r = await ensureTaxonomyValue(
      supabaseAdmin(),
      admin.orgId,
      { kind, value, label: str(body.label, 120) || null, domain, objectType, intelligenceClass: str(body.intelligenceClass, 40) || null, proposedBy: "user", autoApprove: true },
      known
    );
    return Response.json({ ok: true, ...r, predefined: !r.created && known.includes(r.value) });
  } catch (e) {
    return dbError(e);
  }
}

export async function PATCH(req: Request) {
  const g = await guard("documents:write");
  if ("response" in g) return g.response;
  const { admin } = g;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = str(body.action, 20);

  if (body.ids !== undefined) {
    if (!["approve", "reject"].includes(action)) {
      return Response.json({ error: "ids and action (approve|reject) required; rename one value at a time" }, { status: 400 });
    }
    const parsed = parseIds(body.ids);
    if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
    try {
      const { data, error } = await supabaseAdmin()
        .from("taxonomy_values")
        .update({ status: action === "approve" ? "approved" : "rejected" })
        .in("id", parsed.ids)
        .eq("org_id", admin.orgId)
        .select("id");
      if (error) throw error;
      const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
      return Response.json({ ok: true, updated: ids.length, ids });
    } catch (e) {
      return dbError(e);
    }
  }

  const id = uuid(body.id);
  if (!id || !["approve", "reject", "rename"].includes(action)) return Response.json({ error: "id and action (approve|reject|rename) required" }, { status: 400 });
  const db = supabaseAdmin();
  try {
    const patch: Record<string, unknown> =
      action === "approve" ? { status: "approved" } : action === "reject" ? { status: "rejected" } : {};
    if (action === "rename") {
      const value = slugify(str(body.value, 80));
      if (!value) return Response.json({ error: "value required" }, { status: 400 });
      patch.value = value;
      if (str(body.label, 120)) patch.label = str(body.label, 120);
    }
    const { data: row, error } = await db.from("taxonomy_values").update(patch).eq("id", id).eq("org_id", admin.orgId).select("*").single();
    if (error) throw error;
    // Renaming a subtype re-labels the objects that use it.
    if (action === "rename" && row?.kind === "subtype" && str(body.previousValue, 80)) {
      await db.from("knowledge_objects").update({ subtype: patch.value }).eq("org_id", admin.orgId).eq("subtype", str(body.previousValue, 80)).then(() => {}, () => {});
    }
    return Response.json({ ok: true, value: row });
  } catch (e) {
    return dbError(e);
  }
}
