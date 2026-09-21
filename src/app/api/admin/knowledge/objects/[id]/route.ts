// /api/admin/knowledge/objects/[id]
//   GET    — full detail: object + markdown + relationships (both directions,
//            resolved) + entities + chunk count + decision log + learning record
//   PATCH  — governance / metadata edits; a markdown edit re-chunks + re-embeds
//            the object in place (same document id) and bumps the version
//   DELETE — removes the object, its compiled + raw documents (chunks cascade),
//            edges, mentions and learning record

import { supabaseAdmin } from "@/lib/supabase";
import { reingestDocument } from "@/lib/ingest";
import { embed } from "@/lib/embeddings";
import {
  getObject,
  buildFrontmatter,
  assembleMarkdown,
  splitSections,
  objectContextLine,
  objectEmbeddingText,
  logDecision,
  OBJECT_COLUMNS,
  type KnowledgeObjectRow,
} from "@/lib/knowledge-store";
import {
  defaultAuthority,
  realityBucketOf,
  isAuthority,
  isDomain,
  slugify,
  FOUNDER_ENDORSEMENTS,
  IMPLEMENTATION_STATUSES,
  INTERNAL_VALIDATIONS,
  PRIORITIES,
  OBJECT_STATUSES,
  EVIDENCE_LEVELS,
} from "@/lib/intelligence-taxonomy";
import { guard, dbError, objectStubs, str, strOrNull, strList } from "../../_shared";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const g = await guard();
  if ("response" in g) return g.response;
  const { admin } = g;
  const { id } = await ctx.params;
  const db = supabaseAdmin();
  try {
    const object = await getObject(db, admin.orgId, id, true);
    if (!object) return Response.json({ error: "Not found" }, { status: 404 });

    const [edgesRes, mentionsRes, chunksRes, decisionsRes, learningRes, childrenRes] = await Promise.all([
      db.from("knowledge_relationships").select("*").eq("org_id", admin.orgId).or(`source_object_id.eq.${id},target_object_id.eq.${id}`).limit(300),
      db.from("entity_mentions").select("id, role, value, entity_id, entities(id, kind, name, slug, mention_count)").eq("org_id", admin.orgId).eq("object_id", id).limit(200),
      db.from("chunks").select("id", { count: "exact", head: true }).eq("org_id", admin.orgId).eq("object_id", id),
      db.from("ingestion_decisions").select("id, stage, decision, input, output, model, confidence, duration_ms, created_at").eq("org_id", admin.orgId).eq("object_id", id).order("created_at", { ascending: false }).limit(40),
      db.from("learning_records").select("*").eq("org_id", admin.orgId).eq("object_id", id).maybeSingle(),
      db.from("learning_records").select("id, object_id, record_type, lifecycle_status").eq("org_id", admin.orgId).limit(500),
    ]);

    const edges = (edgesRes.data ?? []) as { id: string; source_object_id: string; relationship_type: string; target_object_id: string; status: string; confidence: number | null; origin: string; note: string | null }[];
    const stubs = await objectStubs(admin.orgId, edges.flatMap((e) => [e.source_object_id, e.target_object_id]));
    const relationships = edges.map((e) => ({
      ...e,
      direction: e.source_object_id === id ? "out" : "in",
      other: stubs[e.source_object_id === id ? e.target_object_id : e.source_object_id] ?? null,
    }));

    const learning = (learningRes.data ?? null) as Record<string, unknown> | null;
    // Learning chain: parent + children records (resolved to refs).
    let chain: unknown[] = [];
    if (learning) {
      const all = (childrenRes.data ?? []) as { id: string; object_id: string; record_type: string; lifecycle_status: string }[];
      const recId = learning.id as string;
      const parentId = learning.parent_record_id as string | null;
      const related = all.filter((r) => r.id === parentId || (r as { parent_record_id?: string }).parent_record_id === recId);
      const childRows = await db.from("learning_records").select("id, object_id, record_type, lifecycle_status, parent_record_id").eq("org_id", admin.orgId).eq("parent_record_id", recId);
      const rows = [...related, ...(((childRows.data ?? []) as typeof related))];
      const st = await objectStubs(admin.orgId, rows.map((r) => r.object_id));
      chain = rows.map((r) => ({ ...r, object: st[r.object_id] ?? null }));
    }

    return Response.json({
      object: { ...object, bucket: object.intelligence_class === "business_reality" ? realityBucketOf(object) : null },
      sections: splitSections(object.compiled_markdown ?? "").sections,
      relationships,
      entities: (mentionsRes.data ?? []).map((m: Record<string, unknown>) => ({ id: m.id, role: m.role, value: m.value, entity: m.entities })),
      chunkCount: chunksRes.count ?? 0,
      decisions: decisionsRes.data ?? [],
      learning,
      learningChain: chain,
    });
  } catch (e) {
    return dbError(e);
  }
}

const ENUMS = {
  status: OBJECT_STATUSES.map((s) => s.id),
  priority: PRIORITIES.map((p) => p.id),
  founder_endorsement: FOUNDER_ENDORSEMENTS.map((e) => e.id),
  implementation_status: IMPLEMENTATION_STATUSES.map((s) => s.id),
  internal_validation: INTERNAL_VALIDATIONS.map((v) => v.id),
  evidence_level: EVIDENCE_LEVELS.map((e) => e.id),
};

export async function PATCH(req: Request, ctx: Ctx) {
  const g = await guard("documents:write");
  if ("response" in g) return g.response;
  const { admin } = g;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const db = supabaseAdmin();
  try {
    const current = await getObject(db, admin.orgId, id, true);
    if (!current) return Response.json({ error: "Not found" }, { status: 404 });

    const patch: Record<string, unknown> = {};
    const pick = (k: keyof typeof ENUMS) => {
      const v = str(body[k], 40);
      if (v && (ENUMS[k] as readonly string[]).includes(v)) patch[k] = v;
      else if (k === "founder_endorsement" && body[k] === null) patch[k] = null;
    };
    (["status", "priority", "founder_endorsement", "implementation_status", "internal_validation", "evidence_level"] as const).forEach(pick);
    if (str(body.name, 200)) patch.name = str(body.name, 200);
    if (typeof body.summary === "string") patch.summary = body.summary.trim().slice(0, 4000);
    if (str(body.domain, 40) && isDomain(str(body.domain, 40))) patch.domain = str(body.domain, 40);
    if (str(body.object_type, 60)) patch.object_type = slugify(str(body.object_type, 60));
    if (body.subtype !== undefined) patch.subtype = body.subtype ? slugify(str(body.subtype, 60)) : null;
    if (Array.isArray(body.tags)) patch.tags = strList(body.tags).map(slugify);
    if (Array.isArray(body.applies_to)) patch.applies_to = strList(body.applies_to).map(slugify);
    if (Array.isArray(body.goals)) patch.goals = strList(body.goals).map(slugify);
    if (Array.isArray(body.applies_to_platforms)) patch.applies_to_platforms = strList(body.applies_to_platforms).map(slugify);
    for (const k of ["source_expert", "source_type", "source_platform", "source_url"] as const) {
      if (body[k] !== undefined) patch[k] = strOrNull(body[k], 500);
    }
    for (const k of ["effective_from", "effective_until", "last_verified_at"] as const) {
      if (body[k] !== undefined) {
        const t = body[k] ? Date.parse(String(body[k])) : NaN;
        patch[k] = Number.isNaN(t) ? null : new Date(t).toISOString();
      }
    }
    if (body.verify_now === true) patch.last_verified_at = new Date().toISOString();
    if (str(body.authority, 4) && isAuthority(str(body.authority, 4))) patch.authority = str(body.authority, 4);
    else if (Object.keys(patch).some((k) => ["status", "founder_endorsement", "internal_validation", "domain", "object_type"].includes(k))) {
      const next = { ...current, ...patch } as KnowledgeObjectRow;
      patch.authority = defaultAuthority({ ...next, bucket: next.intelligence_class === "business_reality" ? realityBucketOf(next) : null });
    }

    // Markdown edit → rebuild frontmatter from (patched) metadata, re-chunk in place.
    let chunks: number | null = null;
    const md = typeof body.compiled_markdown === "string" ? body.compiled_markdown : null;
    const nextMeta = { ...current, ...patch } as KnowledgeObjectRow;
    if (md && md.trim()) {
      const parts = splitSections(md);
      const version = (current.version ?? 1) + 1;
      const rebuilt = assembleMarkdown(buildFrontmatter({ ...nextMeta, version }), parts.title || nextMeta.name, parts.sections);
      patch.compiled_markdown = rebuilt;
      patch.version = version;
      const vec = await embed(objectEmbeddingText(nextMeta.name, nextMeta.summary, parts.sections));
      if (vec.some((v) => v !== 0)) patch.embedding = vec;
      if (current.document_id) {
        const r = await reingestDocument(db, {
          orgId: admin.orgId,
          documentId: current.document_id,
          text: rebuilt,
          title: nextMeta.name,
          metadata: { object_version: version, authority: nextMeta.authority, founder_endorsement: nextMeta.founder_endorsement, status: nextMeta.status },
          chunkStrategy: "knowledge_object",
          contextPrefix: objectContextLine(nextMeta),
          intelligenceClass: nextMeta.intelligence_class,
          domain: nextMeta.domain,
          objectId: current.id,
        });
        chunks = r.chunks;
      }
    } else if (patch.name || patch.domain || patch.object_type || patch.subtype || patch.authority || patch.founder_endorsement !== undefined || patch.status) {
      // Metadata-only change: keep the compiled markdown's frontmatter in sync (no re-chunk).
      const parts = splitSections(current.compiled_markdown ?? "");
      if (parts.sections.length) patch.compiled_markdown = assembleMarkdown(buildFrontmatter(nextMeta), parts.title || nextMeta.name, parts.sections);
      if (current.document_id && patch.domain) {
        await db.from("documents").update({ domain: patch.domain }).eq("id", current.document_id).then(() => {}, () => {});
        await db.from("chunks").update({ domain: patch.domain }).eq("object_id", current.id).then(() => {}, () => {});
      }
    }

    if (Object.keys(patch).length === 0) return Response.json({ object: current, chunks });
    const { data, error } = await db.from("knowledge_objects").update(patch).eq("id", id).eq("org_id", admin.orgId).select(OBJECT_COLUMNS).single();
    if (error) throw error;
    await logDecision(db, admin.orgId, { objectId: id, stage: "persist", decision: md ? "markdown_edited" : "governance_edited", input: { fields: Object.keys(patch) }, output: { by: admin.email } });
    return Response.json({ object: data, chunks });
  } catch (e) {
    return dbError(e);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const g = await guard("documents:write");
  if ("response" in g) return g.response;
  const { admin } = g;
  const { id } = await ctx.params;
  const db = supabaseAdmin();
  try {
    const current = await getObject(db, admin.orgId, id, false);
    if (!current) return Response.json({ error: "Not found" }, { status: 404 });
    const docIds = [current.document_id, current.raw_document_id].filter((x): x is string => !!x);
    if (docIds.length) await db.from("documents").delete().eq("org_id", admin.orgId).in("id", docIds);
    const { error } = await db.from("knowledge_objects").delete().eq("id", id).eq("org_id", admin.orgId);
    if (error) throw error;
    return Response.json({ ok: true, deletedDocuments: docIds.length });
  } catch (e) {
    return dbError(e);
  }
}
