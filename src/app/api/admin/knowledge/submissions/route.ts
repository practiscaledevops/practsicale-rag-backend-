// /api/admin/knowledge/submissions — the knowledge approval queue.
//
//   GET   → the submissions this caller may see (guard documents:read):
//           an APPROVER (super_admin / documents:approve) sees every submission in
//           the org; a plain uploader sees ONLY their own. + status counts + canApprove.
//           The heavy replay `payload` is never returned — only the compiled `preview`.
//   POST  → approve / reject (guard documents:approve, so an uploader who holds only
//           documents:write gets 403 — they cannot self-approve):
//             { id, action: "approve" }                 → replay the commit once, mark approved
//             { id, action: "reject", note? }           → mark rejected (row kept for the audit)
//             { ids, action: "approve" }                → many, sequentially, within a time budget
//             { ids, action: "reject", note? }          → many, in one org-scoped update
//
// Approve is the ONLY place a queued upload becomes retrievable: it calls
// replaySubmission (compileKnowledge for compile kinds, ingestOne for bulk) with the
// submitter's identity and org, then records the committed object id. Idempotent: a
// submission already approved is not replayed again. Every statement is org-scoped.

import { supabaseAdmin } from "@/lib/supabase";
import { isMissingRelation } from "@/lib/knowledge-store";
import { bulkErrorMessage } from "@/lib/bulk";
import {
  isApprover,
  replaySubmission,
  type KnowledgeSubmissionRow,
  type SubmissionStatus,
} from "@/lib/knowledge-submissions";
import type { AdminSession } from "@/lib/auth/session";
import type { SupabaseClient } from "@supabase/supabase-js";
import { guard, dbError, str, uuid } from "../_shared";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
// Approve replays compileKnowledge / ingestOne (classify → dedup → compile → embed,
// or redact → chunk → embed) — the same heavy work the upload routes allow 300s for.
export const maxDuration = 300;

/** Approvals per bulk request. Each approve is heavy (LLM + embeddings), so small. */
const BULK_MAX_APPROVE = 25;
/** Rejects per bulk request. One set-based update, so a larger cap is fine. */
const BULK_MAX_REJECT = 200;
/** Stop starting new approvals after this long; the client resends `remaining`. */
const APPROVE_BUDGET_MS = 250_000;

/** The columns the queue UI needs — never the replay `payload` (large; may hold 400k+ chars). */
const LIST_COLUMNS =
  "id, submitted_by, submitted_by_email, title, kind, commit_via, source_type, intelligence_class, bucket, preview, status, review_note, reviewed_by, reviewed_at, committed_object_id, created_at";

const STATUSES: SubmissionStatus[] = ["pending", "approved", "rejected"];

/**
 * A bulk id list: 1..max uuids, deduped (ids are interpolated into PostgREST
 * `in (…)` filters, so free text is refused rather than dropped).
 */
function bulkIds(v: unknown, max: number, field: string): { ids: string[] } | { error: string } {
  if (!Array.isArray(v)) return { error: `${field} must be an array of ids` };
  const ids = new Set<string>();
  for (const x of v) {
    const id = uuid(x);
    if (!id) return { error: `${field} must contain only ids (uuid)` };
    ids.add(id);
  }
  if (ids.size === 0) return { error: `${field} must not be empty` };
  if (ids.size > max) return { error: `At most ${max} ${field} per request` };
  return { ids: Array.from(ids) };
}

export async function GET(req: Request) {
  const g = await guard("documents:read");
  if ("response" in g) return g.response;
  const { admin } = g;
  const approver = isApprover(admin);
  const url = new URL(req.url);
  const statusFilter = str(url.searchParams.get("status"), 20);
  const db = supabaseAdmin();
  try {
    let q = db.from("knowledge_submissions").select(LIST_COLUMNS).eq("org_id", admin.orgId);
    // A non-approver only ever sees their OWN submissions (app-layer gate, like the
    // rest of the codebase); approvers see the whole org's queue.
    if (!approver) q = q.eq("submitted_by", admin.memberId);
    if ((STATUSES as string[]).includes(statusFilter)) q = q.eq("status", statusFilter);
    const { data, error } = await q.order("created_at", { ascending: false }).limit(500);
    if (error) throw error;

    // Counts across the same scope (self for an uploader, whole org for an approver).
    let countQ = db.from("knowledge_submissions").select("status").eq("org_id", admin.orgId);
    if (!approver) countQ = countQ.eq("submitted_by", admin.memberId);
    const { data: statusRows } = await countQ.limit(5000);
    const counts: Record<SubmissionStatus, number> = { pending: 0, approved: 0, rejected: 0 };
    for (const r of (statusRows ?? []) as { status: SubmissionStatus }[]) {
      if (r.status in counts) counts[r.status] += 1;
    }

    return Response.json({ items: data ?? [], counts, canApprove: approver });
  } catch (e) {
    return dbError(e);
  }
}

type ApproveOutcome =
  | { ok: true; status: "approved"; committedObjectId: string | null; chunks: number; alreadyApproved?: boolean }
  | { ok: false; error: string; status: number };

/**
 * Approve one submission: replay its commit EXACTLY as the submitter would have run
 * it (same org, createdBy = submitter), then mark it approved and record the object.
 *
 * The status flip is the LOCK: we claim the row (pending → approved) atomically BEFORE
 * replaying, so Postgres serialises concurrent approves on the row and only the one
 * that matches `status = 'pending'` proceeds to the heavy replay. This closes two races
 * the old check-then-act order left open — two approves double-ingesting a compile
 * submission, and an approve that replays after a concurrent reject (which would mark
 * the row "rejected" yet leave its content live). If the replay is blocked or throws,
 * the claim is reverted to pending so the item returns to the queue and stays retryable.
 * Idempotent — a submission already approved is returned without replaying.
 */
async function approveSubmission(db: SupabaseClient, admin: AdminSession, id: string): Promise<ApproveOutcome> {
  // Fast-path read, only for accurate 404 / already-approved / already-rejected replies.
  const { data: subRow } = await db
    .from("knowledge_submissions")
    .select("*")
    .eq("id", id)
    .eq("org_id", admin.orgId)
    .maybeSingle();
  if (!subRow) return { ok: false, error: "Not found", status: 404 };
  const existing = subRow as KnowledgeSubmissionRow;
  if (existing.status === "approved") {
    return { ok: true, status: "approved", committedObjectId: existing.committed_object_id, chunks: 0, alreadyApproved: true };
  }
  if (existing.status === "rejected") {
    return { ok: false, error: "This submission was already rejected.", status: 409 };
  }

  // Atomic claim: only the request that flips pending → approved replays. A racing
  // approve or reject updates 0 rows here and never ingests.
  const { data: claimedRow } = await db
    .from("knowledge_submissions")
    .update({ status: "approved", reviewed_by: admin.memberId, reviewed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("org_id", admin.orgId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (!claimedRow) {
    // Someone else won the row between our read and the claim — report its real state.
    const { data: now } = await db
      .from("knowledge_submissions")
      .select("status, committed_object_id")
      .eq("id", id)
      .eq("org_id", admin.orgId)
      .maybeSingle();
    const n = now as { status?: SubmissionStatus; committed_object_id?: string | null } | null;
    if (n?.status === "approved") return { ok: true, status: "approved", committedObjectId: n.committed_object_id ?? null, chunks: 0, alreadyApproved: true };
    if (n?.status === "rejected") return { ok: false, error: "This submission was already rejected.", status: 409 };
    return { ok: false, error: "Not found", status: 404 };
  }
  const sub = claimedRow as KnowledgeSubmissionRow;

  // Revert the claim so a blocked / failed replay leaves the row pending (retryable).
  const revertClaim = async () => {
    await db
      .from("knowledge_submissions")
      .update({ status: "pending", reviewed_by: null, reviewed_at: null })
      .eq("id", id)
      .eq("org_id", admin.orgId)
      .eq("status", "approved");
  };

  let replay;
  try {
    replay = await replaySubmission(db, sub);
  } catch (e) {
    await revertClaim();
    throw e;
  }
  if (replay.blocked) {
    await revertClaim();
    return { ok: false, error: replay.blocked.reason, status: 422 };
  }

  // Record the committed object id now that the content is live.
  await db
    .from("knowledge_submissions")
    .update({ committed_object_id: replay.committedObjectId })
    .eq("id", id)
    .eq("org_id", admin.orgId);

  return { ok: true, status: "approved", committedObjectId: replay.committedObjectId, chunks: replay.chunks };
}

/** Reject many in one org-scoped update (pending rows only); the rows are kept for the audit. */
async function rejectMany(admin: AdminSession, ids: string[], note: string | null): Promise<Response> {
  const db = supabaseAdmin();
  try {
    const { data, error } = await db
      .from("knowledge_submissions")
      .update({
        status: "rejected",
        review_note: note,
        reviewed_by: admin.memberId,
        reviewed_at: new Date().toISOString(),
      })
      .eq("org_id", admin.orgId)
      .in("id", ids)
      .eq("status", "pending")
      .select("id");
    if (error) throw error;
    const done = ((data ?? []) as { id: string }[]).map((r) => r.id);
    const doneSet = new Set(done);
    return Response.json({ ok: true, rejected: done.length, ids: done, missing: ids.filter((id) => !doneSet.has(id)) });
  } catch (e) {
    return dbError(e);
  }
}

/** Approve many, strictly one after another (each replays heavy work), within a time budget. */
async function approveManyRequest(admin: AdminSession, ids: string[]): Promise<Response> {
  const db = supabaseAdmin();
  const started = Date.now();
  const done: string[] = [];
  const failed: { id: string; error: string; status: number }[] = [];
  let remaining: string[] = [];
  try {
    for (let i = 0; i < ids.length; i++) {
      if (i > 0 && Date.now() - started > APPROVE_BUDGET_MS) {
        remaining = ids.slice(i);
        break;
      }
      const id = ids[i];
      try {
        const r = await approveSubmission(db, admin, id);
        if (r.ok) done.push(id);
        else failed.push({ id, error: r.error, status: r.status });
      } catch (e) {
        // A missing table fails every row the same way: surface it like the single form.
        if (isMissingRelation(e as { code?: string; message?: string })) throw e;
        failed.push({ id, error: bulkErrorMessage(e, "Approve failed"), status: 500 });
      }
    }
    return Response.json({ ok: true, done, failed, remaining });
  } catch (e) {
    return dbError(e);
  }
}

export async function POST(req: Request) {
  const g = await guard("documents:approve");
  if ("response" in g) return g.response;
  const { admin } = g;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = str(body.action, 20);
  if (action !== "approve" && action !== "reject") {
    return Response.json({ error: "action must be approve or reject" }, { status: 400 });
  }
  const note = str(body.note ?? body.reviewNote, 2000) || null;

  // Bulk form: { ids, action }.
  if (body.ids !== undefined) {
    const parsed = bulkIds(body.ids, action === "approve" ? BULK_MAX_APPROVE : BULK_MAX_REJECT, "ids");
    if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
    return action === "approve" ? approveManyRequest(admin, parsed.ids) : rejectMany(admin, parsed.ids, note);
  }

  // Single form: { id, action }.
  const id = uuid(body.id);
  if (!id) return Response.json({ error: "id (uuid) required" }, { status: 400 });

  if (action === "reject") {
    const db = supabaseAdmin();
    try {
      const { data, error } = await db
        .from("knowledge_submissions")
        .update({
          status: "rejected",
          review_note: note,
          reviewed_by: admin.memberId,
          reviewed_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("org_id", admin.orgId)
        .eq("status", "pending")
        .select("id, status")
        .maybeSingle();
      if (error) throw error;
      if (!data) return Response.json({ error: "Not found, or already reviewed." }, { status: 409 });
      return Response.json({ ok: true, id, status: "rejected" });
    } catch (e) {
      return dbError(e);
    }
  }

  // Single approve.
  const db = supabaseAdmin();
  try {
    const r = await approveSubmission(db, admin, id);
    if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
    return Response.json({ ok: true, id, status: "approved", committedObjectId: r.committedObjectId, chunks: r.chunks, alreadyApproved: r.alreadyApproved ?? false });
  } catch (e) {
    return dbError(e);
  }
}
