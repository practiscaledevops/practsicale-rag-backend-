// /api/admin/knowledge/learning — the Learning Lab (Organizational Learning).
//   GET   → records joined with their objects + counts by type/status + the
//           follow-up queue (new evidence the Brain thinks belongs to an open record)
//   POST  → record a learning / experiment / decision manually (compiled like any object)
//           or a follow-up action: { action: "attach_evidence" | "compute_result" | "ignore", edgeId }
//   PATCH → { id, lifecycleStatus?, department?, owner?, confidence?, metricsBefore?,
//             metricsAfter?, evidenceDocumentIds?, missingEvidence?, parentRecordId?,
//             action?: "promote_standard" (playbookRefs?) | "validate" | "reject" }

import { supabaseAdmin } from "@/lib/supabase";
import { compileKnowledge } from "@/lib/knowledge-compiler";
import { getObjectByRef, upsertRelationship, logDecision, OBJECT_COLUMNS } from "@/lib/knowledge-store";
import { LEARNING_RECORD_TYPES, LEARNING_STATUSES } from "@/lib/intelligence-taxonomy";
import { loadSettings } from "@/lib/settings";
import {
  listFollowupQueue,
  loadFollowupContext,
  attachEvidence,
  ignoreFollowup,
  computeResultFromEvidence,
  resultRecordMarkdown,
  metricsAfterObject,
} from "@/lib/learning-followup";
import type { AdminSession } from "@/lib/auth/session";
import { guard, dbError, objectStubs, str, strOrNull, strList } from "../_shared";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 120;

export async function GET(req: Request) {
  const g = await guard();
  if ("response" in g) return g.response;
  const { admin } = g;
  const url = new URL(req.url);
  const type = str(url.searchParams.get("type"), 40);
  const status = str(url.searchParams.get("status"), 40);
  const db = supabaseAdmin();
  try {
    let q = db.from("learning_records").select("*").eq("org_id", admin.orgId);
    if (type) q = q.eq("record_type", type);
    if (status) q = q.eq("lifecycle_status", status);
    const { data, error } = await q.order("updated_at", { ascending: false }).limit(500);
    if (error) throw error;
    const records = (data ?? []) as { object_id: string; record_type: string; lifecycle_status: string; related_playbook_refs: string[] }[];
    const { data: objs } = await db.from("knowledge_objects").select(OBJECT_COLUMNS).eq("org_id", admin.orgId).in("id", records.map((r) => r.object_id).concat(["00000000-0000-0000-0000-000000000000"]));
    const byId = new Map(((objs ?? []) as { id: string }[]).map((o) => [o.id, o]));
    // Counts across ALL records (not just the filtered page).
    const { data: all } = await db.from("learning_records").select("record_type, lifecycle_status").eq("org_id", admin.orgId).limit(5000);
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const r of (all ?? []) as { record_type: string; lifecycle_status: string }[]) {
      byType[r.record_type] = (byType[r.record_type] ?? 0) + 1;
      byStatus[r.lifecycle_status] = (byStatus[r.lifecycle_status] ?? 0) + 1;
    }
    // Suggested evidence links (AI-suggested uses_evidence edges awaiting review) per record.
    const objIds = records.map((r) => r.object_id);
    const { data: suggested } = objIds.length
      ? await db.from("knowledge_relationships").select("source_object_id, target_object_id, relationship_type, confidence").eq("org_id", admin.orgId).eq("status", "suggested").in("source_object_id", objIds)
      : { data: [] };
    // The follow-up queue is independent of the type/status filter (like the counts).
    const followups = await listFollowupQueue(db, admin.orgId);
    return Response.json({
      items: records.map((r) => ({ record: r, object: byId.get(r.object_id) ?? null })),
      counts: { byType, byStatus },
      suggestedEdges: suggested ?? [],
      followups,
    });
  } catch (e) {
    return dbError(e);
  }
}

export async function POST(req: Request) {
  const g = await guard("documents:write");
  if ("response" in g) return g.response;
  const { admin } = g;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const followupAction = str(body.action, 30);
  if (followupAction) return followup(admin, followupAction, str(body.edgeId, 64));
  const kind = LEARNING_RECORD_TYPES.includes(str(body.kind, 40)) ? str(body.kind, 40) : "learning";
  const title = str(body.title, 200);
  const change = str(body.change, 8000);
  if (!title && !change) return Response.json({ error: "title or change is required" }, { status: 400 });
  const observed = str(body.observedResult, 8000);
  const notes = str(body.notes, 12000);
  const department = strOrNull(body.department, 120);
  const relatedRefs = strList(body.relatedRefs, 12).map((r) => r.toUpperCase());
  const missing = strList(body.missingEvidence, 12);
  const text = [
    `# ${title || change.slice(0, 80)}`,
    "",
    `Record type: ${kind}`,
    department ? `Department / team: ${department}` : "",
    relatedRefs.length ? `Frameworks used: ${relatedRefs.join(", ")}` : "",
    "",
    "## What we changed / decided",
    change || title,
    observed ? `\n## Observed result\n${observed}` : "",
    notes ? `\n## Notes\n${notes}` : "",
    missing.length ? `\n## Missing evidence (to complete)\n${missing.map((m) => `- ${m}`).join("\n")}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  const db = supabaseAdmin();
  try {
    const res = await compileKnowledge(db, {
      orgId: admin.orgId,
      intelligenceClass: "organizational_learning",
      text,
      title: title || null,
      mode: "commit",
      forceNew: true,
      storeRaw: false,
      createdBy: admin.email,
      hints: {
        objectType: kind,
        learning: {
          recordType: kind,
          lifecycleStatus: LEARNING_STATUSES.some((s) => s.id === str(body.lifecycleStatus, 20)) ? str(body.lifecycleStatus, 20) : undefined,
          department,
          owner: strOrNull(body.owner, 120),
          relatedPlaybookRefs: relatedRefs,
          missingEvidence: missing,
          confidence: ["low", "medium", "high"].includes(str(body.confidence, 10)) ? (str(body.confidence, 10) as "low" | "medium" | "high") : null,
          changes: body.changes && typeof body.changes === "object" ? (body.changes as Record<string, unknown>) : {},
          metricsBefore: body.metricsBefore && typeof body.metricsBefore === "object" ? (body.metricsBefore as Record<string, unknown>) : {},
          metricsAfter: body.metricsAfter && typeof body.metricsAfter === "object" ? (body.metricsAfter as Record<string, unknown>) : {},
          evidenceDocumentIds: strList(body.evidenceDocumentIds, 20),
          parentRecordId: strOrNull(body.parentRecordId, 64),
          source: "manual",
        },
      },
    });
    if (res.blocked) return Response.json({ error: res.blocked.reason }, { status: 422 });
    return Response.json({ ok: true, object: res.object, ref: res.object?.ref ?? null });
  } catch (e) {
    return dbError(e);
  }
}

/**
 * The follow-up queue actions on a suggested `evidence_for` edge:
 *   attach_evidence → confirm the edge, add the document to the record's evidence,
 *                     implementing → measuring
 *   compute_result  → attach, then compare the record (changes + metrics before)
 *                     with the evidence and propose a child Result record
 *                     (status proposed, RES ref, `produced_result` edge)
 *   ignore          → reject the edge (not proposed again)
 */
async function followup(admin: AdminSession, action: string, edgeId: string): Promise<Response> {
  if (!["attach_evidence", "compute_result", "ignore"].includes(action)) return Response.json({ error: "Unknown action" }, { status: 400 });
  if (!edgeId) return Response.json({ error: "edgeId required" }, { status: 400 });
  const db = supabaseAdmin();
  try {
    const ctx = await loadFollowupContext(db, admin.orgId, edgeId);
    if (!ctx) return Response.json({ error: "Not found" }, { status: 404 });

    // Only a live suggestion can be dismissed; a confirmed edge is evidence the
    // record already relies on (two reviewers, or a stale queue).
    if (action === "ignore") {
      if (ctx.edge.status !== "suggested") return Response.json({ error: "This suggestion was already reviewed." }, { status: 409 });
      await ignoreFollowup(db, admin.orgId, ctx, admin.email);
      return Response.json({ ok: true });
    }
    if (ctx.edge.status === "rejected") return Response.json({ error: "This suggestion was ignored earlier." }, { status: 409 });

    const record = await attachEvidence(db, admin.orgId, ctx, admin.email);
    if (action === "attach_evidence") return Response.json({ ok: true, record });

    // compute_result — idempotent: a Result already computed from this evidence
    // (a retry after a failed compile, or a second reviewer) is returned, not duplicated.
    const { data: prior } = await db
      .from("knowledge_relationships")
      .select("source_object_id")
      .eq("org_id", admin.orgId)
      .eq("relationship_type", "uses_evidence")
      .eq("target_object_id", ctx.evidence.id)
      .eq("status", "confirmed")
      .limit(1)
      .maybeSingle();
    if (prior?.source_object_id) {
      return Response.json({ ok: true, existing: true, resultObjectId: prior.source_object_id as string });
    }
    const { settings } = await loadSettings(admin.orgId, db);
    const computed = await computeResultFromEvidence({ record, recordObject: ctx.recordObject, evidence: ctx.evidence, tier: settings.intelligence.compileTier });
    const { name, markdown } = resultRecordMarkdown({ record, recordObject: ctx.recordObject, evidence: ctx.evidence, computed });
    const res = await compileKnowledge(db, {
      orgId: admin.orgId,
      intelligenceClass: "organizational_learning",
      text: markdown,
      title: name,
      mode: "commit",
      forceNew: true,
      storeRaw: false,
      createdBy: admin.email,
      hints: {
        objectType: "result",
        learning: {
          recordType: "result",
          lifecycleStatus: "proposed",
          department: record.department,
          owner: record.owner,
          relatedPlaybookRefs: record.related_playbook_refs ?? [],
          metricsBefore: record.metrics_before ?? {},
          metricsAfter: metricsAfterObject(computed.metricsAfter),
          confidence: computed.confidence,
          evidenceDocumentIds: ctx.evidence.document_id ? [ctx.evidence.document_id] : [],
          parentRecordId: record.id,
          source: "auto",
        },
      },
    });
    if (res.blocked || !res.object) return Response.json({ error: res.blocked?.reason ?? "Result could not be saved" }, { status: 422 });
    await upsertRelationship(db, admin.orgId, { sourceId: ctx.recordObject.id, type: "produced_result", targetId: res.object.id, status: "confirmed", origin: "system", note: `Computed from ${ctx.evidence.ref}` });
    await upsertRelationship(db, admin.orgId, { sourceId: res.object.id, type: "uses_evidence", targetId: ctx.evidence.id, status: "confirmed", origin: "system" });
    await logDecision(db, admin.orgId, {
      objectId: res.object.id,
      stage: "learning",
      decision: "result_computed",
      input: { record: record.id, recordRef: ctx.recordObject.ref, evidenceRef: ctx.evidence.ref, tier: settings.intelligence.compileTier },
      output: { ref: res.object.ref, via: computed.via, confidence: computed.confidence, metricsAfter: computed.metricsAfter, by: admin.email },
      model: computed.model,
    });
    return Response.json({
      ok: true,
      record,
      result: { id: res.object.id, ref: res.object.ref, name: res.object.name },
      computed: { via: computed.via, model: computed.model, confidence: computed.confidence, summary: computed.summary, metricsAfter: computed.metricsAfter },
    });
  } catch (e) {
    return dbError(e);
  }
}

export async function PATCH(req: Request) {
  const g = await guard("documents:write");
  if ("response" in g) return g.response;
  const { admin } = g;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const id = str(body.id, 64);
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  const db = supabaseAdmin();
  try {
    const { data: rec } = await db.from("learning_records").select("*").eq("id", id).eq("org_id", admin.orgId).maybeSingle();
    if (!rec) return Response.json({ error: "Not found" }, { status: 404 });
    const record = rec as Record<string, unknown> & { object_id: string; related_playbook_refs: string[] };
    const patch: Record<string, unknown> = {};
    const ls = str(body.lifecycleStatus, 20);
    if (ls && LEARNING_STATUSES.some((s) => s.id === ls)) patch.lifecycle_status = ls;
    if (body.department !== undefined) patch.department = strOrNull(body.department, 120);
    if (body.owner !== undefined) patch.owner = strOrNull(body.owner, 120);
    if (["low", "medium", "high"].includes(str(body.confidence, 10))) patch.confidence = str(body.confidence, 10);
    if (body.metricsBefore && typeof body.metricsBefore === "object") patch.metrics_before = body.metricsBefore;
    if (body.metricsAfter && typeof body.metricsAfter === "object") patch.metrics_after = body.metricsAfter;
    if (Array.isArray(body.evidenceDocumentIds)) patch.evidence_document_ids = strList(body.evidenceDocumentIds, 30);
    if (Array.isArray(body.missingEvidence)) patch.missing_evidence = strList(body.missingEvidence, 12);
    if (body.parentRecordId !== undefined) patch.parent_record_id = strOrNull(body.parentRecordId, 64);
    if (Array.isArray(body.relatedRefs)) patch.related_playbook_refs = strList(body.relatedRefs, 12).map((r) => r.toUpperCase());
    for (const k of ["startedAt", "endedAt"] as const) {
      if (body[k] !== undefined) {
        const t = body[k] ? Date.parse(String(body[k])) : NaN;
        patch[k === "startedAt" ? "started_at" : "ended_at"] = Number.isNaN(t) ? null : new Date(t).toISOString();
      }
    }

    const action = str(body.action, 30);
    if (action === "validate" || action === "reject") {
      patch.lifecycle_status = action === "validate" ? "validated" : "rejected";
      await db.from("knowledge_objects").update({ internal_validation: action === "validate" ? "validated" : "rejected" }).eq("id", record.object_id).eq("org_id", admin.orgId);
    }
    if (action === "promote_standard") {
      // The learning becomes PractiScale's way: the playbooks it adapted are promoted
      // to practiscale_standard (validated, implemented, authority B1) and linked.
      const refs = (strList(body.playbookRefs, 12).length ? strList(body.playbookRefs, 12) : record.related_playbook_refs ?? []).map((r) => r.toUpperCase());
      for (const ref of refs) {
        const pb = await getObjectByRef(db, admin.orgId, ref);
        if (!pb) continue;
        await db
          .from("knowledge_objects")
          .update({ founder_endorsement: "practiscale_standard", internal_validation: "validated", implementation_status: "implemented", authority: "B1", last_verified_at: new Date().toISOString() })
          .eq("id", pb.id)
          .eq("org_id", admin.orgId);
        await upsertRelationship(db, admin.orgId, { sourceId: record.object_id, type: "adapted_into", targetId: pb.id, status: "confirmed", origin: "user", note: "Promoted to PractiScale Standard" });
        await upsertRelationship(db, admin.orgId, { sourceId: pb.id, type: "validated_by", targetId: record.object_id, status: "confirmed", origin: "system" });
        await logDecision(db, admin.orgId, { objectId: pb.id, stage: "learning", decision: "promoted_standard", input: { learningRecord: id }, output: { by: admin.email } });
      }
      patch.lifecycle_status = "validated";
      await db.from("knowledge_objects").update({ internal_validation: "validated", founder_endorsement: "practiscale_standard", authority: "A2" }).eq("id", record.object_id).eq("org_id", admin.orgId);
    }

    if (Object.keys(patch).length === 0) return Response.json({ ok: true, record });
    const { data, error } = await db.from("learning_records").update(patch).eq("id", id).eq("org_id", admin.orgId).select("*").single();
    if (error) throw error;
    const stubs = await objectStubs(admin.orgId, [record.object_id]);
    return Response.json({ ok: true, record: data, object: stubs[record.object_id] ?? null });
  } catch (e) {
    return dbError(e);
  }
}
