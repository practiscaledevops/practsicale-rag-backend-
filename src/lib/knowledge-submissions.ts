// Knowledge submissions — the approval queue for human-uploaded knowledge.
//
// ONE place decides who may commit directly vs. who must wait for review, how a
// pending submission is stored, and how an approved submission is replayed into
// the real ingest path. The three person-driven upload routes (compile wizard,
// bulk upload, learning lab) and the approve route all go through here, so the
// guarantee — "a non-approved submission never creates a chunk / document /
// knowledge_object" — lives in a single, testable module.
//
//   isApprover(session)        → may this caller commit immediately? (super_admin
//                                or the documents:approve grant). hasPermission
//                                applies the super_admin bypass.
//   writeSubmission(db, …)     → park a pending row carrying the full replay
//                                payload (+ the compiled proposal for the reviewer).
//   replaySubmission(db, sub)  → on approve, run the EXACT commit the submitter
//                                would have run (same org, createdBy = submitter):
//                                compileKnowledge for compile kinds, ingestOne for
//                                bulk uploads.
//
// Org is resolved server-side everywhere; the row's org_id drives the replay, and
// the client is never trusted for who-approves.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  compileKnowledge,
  type CompileInput,
  type CompilePreview,
} from "@/lib/knowledge-compiler";
import { ingestOne, type IngestParams } from "@/lib/ingest";
import { hasPermission, type AdminSession } from "@/lib/auth/session";
import type { IntelligenceClass } from "@/lib/intelligence-taxonomy";

/** How the source arrived. Drives display only; dispatch uses `commitVia`. */
export type SubmissionKind = "paste" | "file" | "link" | "bulk" | "learning";

/** Which ingest entry point an approval replays. */
export type CommitVia = "compile" | "ingest_one";

export type SubmissionStatus = "pending" | "approved" | "rejected";

/** The compile-wizard / learning replay payload: a CompileInput minus the fields
 *  supplied at approve time (org, mode, createdBy, runId) and the preview (kept in
 *  its own column so the reviewer can see the proposal without rehydrating). */
export type CompileSubmissionPayload = Omit<
  CompileInput,
  "orgId" | "mode" | "createdBy" | "runId" | "preview"
>;

/** The bulk-upload replay payload: ingestOne params minus the org (added on replay). */
export type IngestSubmissionPayload = Omit<IngestParams, "orgId">;

export interface KnowledgeSubmissionRow {
  id: string;
  org_id: string;
  submitted_by: string | null;
  submitted_by_email: string;
  title: string | null;
  kind: SubmissionKind;
  commit_via: CommitVia;
  source_type: string | null;
  intelligence_class: string | null;
  bucket: string | null;
  payload: CompileSubmissionPayload | IngestSubmissionPayload;
  preview: CompilePreview | null;
  status: SubmissionStatus;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  committed_object_id: string | null;
  storage_path: string | null;
  created_at: string;
}

export interface WriteSubmissionInput {
  orgId: string;
  /** org_members.id of the submitter (null if unknown). */
  submittedBy: string | null;
  submittedByEmail: string;
  title: string | null;
  kind: SubmissionKind;
  commitVia: CommitVia;
  sourceType?: string | null;
  intelligenceClass?: string | null;
  bucket?: string | null;
  payload: CompileSubmissionPayload | IngestSubmissionPayload;
  preview?: CompilePreview | null;
  storagePath?: string | null;
}

/**
 * May this caller's upload go live immediately? True for a super_admin and for
 * anyone holding documents:approve — they ARE the approver. Everyone else (an
 * uploader with only documents:write) has their commit deferred to the queue.
 */
export function isApprover(session: AdminSession): boolean {
  return hasPermission(session, "documents", "approve");
}

/** Park a pending submission; returns its id. Org-scoped by construction. */
export async function writeSubmission(
  db: SupabaseClient,
  input: WriteSubmissionInput
): Promise<string> {
  const { data, error } = await db
    .from("knowledge_submissions")
    .insert({
      org_id: input.orgId,
      submitted_by: input.submittedBy,
      submitted_by_email: input.submittedByEmail,
      title: input.title,
      kind: input.kind,
      commit_via: input.commitVia,
      source_type: input.sourceType ?? null,
      intelligence_class: input.intelligenceClass ?? null,
      bucket: input.bucket ?? null,
      payload: input.payload,
      preview: input.preview ?? null,
      status: "pending",
      storage_path: input.storagePath ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

export interface ReplayResult {
  /** Set when the compiler refused to commit (e.g. the Company Truth guard). */
  blocked: { reason: string } | null;
  /** The knowledge_object (compile) or document (bulk) created, for the audit trail. */
  committedObjectId: string | null;
  documentId: string | null;
  chunks: number;
  /** Bulk only: the content hash already existed, so nothing new was written. */
  skipped?: boolean;
}

/**
 * Replay an approved submission into the real ingest path EXACTLY as the submitter
 * would have, attributed to the submitter and scoped to their org. This is the ONLY
 * place a queued upload becomes retrievable. Dispatches on `commit_via`:
 *   - "ingest_one" (bulk uploads): ingestOne(db, payload) — content-hash idempotent.
 *   - "compile"    (wizard / learning): compileKnowledge(db, payload, mode "commit").
 */
export async function replaySubmission(
  db: SupabaseClient,
  sub: KnowledgeSubmissionRow
): Promise<ReplayResult> {
  if (sub.commit_via === "ingest_one") {
    const payload = sub.payload as IngestSubmissionPayload;
    const res = await ingestOne(db, { ...payload, orgId: sub.org_id });
    return {
      blocked: null,
      committedObjectId: res.documentId,
      documentId: res.documentId,
      chunks: res.chunks,
      skipped: res.skipped,
    };
  }

  const payload = sub.payload as CompileSubmissionPayload;
  const res = await compileKnowledge(db, {
    ...payload,
    orgId: sub.org_id,
    mode: "commit",
    createdBy: sub.submitted_by_email,
    preview: (sub.preview ?? null) as CompilePreview | null,
    // The reviewed preview is the ONLY authoritative artifact: never re-apply a stored
    // client override at approve time, so committed content cannot diverge from what the
    // approver saw. (The compile route already folds any edits into the preview and nulls
    // overrides; forcing null here is defence-in-depth for any older / other submission.)
    overrides: null,
    intelligenceClass: (payload.intelligenceClass ??
      sub.intelligence_class) as IntelligenceClass,
  });
  const committed = res.object?.id ?? res.target?.id ?? null;
  return {
    blocked: res.blocked,
    committedObjectId: committed,
    documentId: res.documentId,
    chunks: res.chunks,
  };
}
