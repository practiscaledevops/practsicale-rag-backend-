// POST /api/admin/knowledge/compile — run the Knowledge Compiler (AI ingestion agent).
//
// The human chooses the intelligence CLASS (and, for Business Reality, the
// bucket); the compiler does the rest: extract, classify, reconcile taxonomy,
// NEW/ENRICH/DUPLICATE/CONFLICT, compile the canonical markdown, chunk, embed,
// entities, relationships — logging every decision.
//
//   mode "preview"  → returns the proposal (nothing written) for the review screen
//   mode "commit"   → persists (optionally from a reviewed `preview` + `overrides`)
//
// Accepts JSON  { mode, class, bucket?, text? | markdown?, title?, hints?, overrides?,
//                 preview?, forceNew?, dedupTargetRef?, confirmTruth?, storeRaw? }
// or multipart  file + fields (mode, class, bucket, title, hints as JSON).
// org_id is resolved server-side; needs the documents:write grant.

import { supabaseAdmin } from "@/lib/supabase";
import { pdfToText } from "@/lib/ingest";
import { compileKnowledge, type CompileInput, type CompilePreview, type DraftOverrides } from "@/lib/knowledge-compiler";
import { isIntelligenceClass, isRealityBucket } from "@/lib/intelligence-taxonomy";
import { isApprover, writeSubmission, type CompileSubmissionPayload } from "@/lib/knowledge-submissions";
import { guard, dbError, str } from "../_shared";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
// classify → dedup judge → compile → embed → entities/relationships is 3–4 model
// calls; a 19k-character book chapter runs well past two minutes on a slow day,
// and the long-source batch compiles two at a time.
export const maxDuration = 300;

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const TEXT_EXT = [".md", ".markdown", ".txt", ".text", ".csv", ".json"];

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

export async function POST(req: Request) {
  const g = await guard("documents:write");
  if ("response" in g) return g.response;
  const { admin } = g;

  let payload: Record<string, unknown> = {};
  let text = "";
  let title = "";
  let hasFile = false;
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return Response.json({ error: "Expected multipart/form-data" }, { status: 400 });
    }
    for (const [k, v] of form.entries()) if (typeof v === "string") payload[k] = v;
    if (typeof payload.hints === "string") {
      try { payload.hints = JSON.parse(payload.hints); } catch { payload.hints = {}; }
    }
    if (typeof payload.overrides === "string") {
      try { payload.overrides = JSON.parse(payload.overrides); } catch { payload.overrides = {}; }
    }
    const file = form.get("file");
    if (file instanceof File) {
      hasFile = true;
      if (file.size > MAX_UPLOAD_BYTES) return Response.json({ error: "File too large (max 25 MB)." }, { status: 413 });
      const ext = extOf(file.name || "");
      try {
        if (ext === ".pdf") text = await pdfToText(Buffer.from(await file.arrayBuffer()));
        else if (TEXT_EXT.includes(ext)) text = await file.text();
        else return Response.json({ error: `Unsupported file type '${ext || file.name}'. Use .md, .txt, .pdf, .csv or .json.` }, { status: 415 });
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : "Could not read file" }, { status: 422 });
      }
      title = file.name;
    }
    if (!text) text = str(payload.text, 400_000) || str(payload.markdown, 400_000);
  } else {
    payload = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    text = str(payload.markdown, 400_000) || str(payload.text, 400_000);
  }
  title = str(payload.title, 200) || title;

  const mode = payload.mode === "commit" ? "commit" : "preview";
  const cls = str(payload.class ?? payload.intelligenceClass, 40);
  if (!isIntelligenceClass(cls) || cls === "raw_archive") {
    return Response.json({ error: "class must be business_reality | playbook | organizational_learning | platform_intelligence | performance_memory" }, { status: 400 });
  }
  const bucketRaw = str(payload.bucket, 40);
  const bucket = isRealityBucket(bucketRaw) ? bucketRaw : null;
  if (!text.trim() && !(payload.preview && mode === "commit")) {
    return Response.json({ error: "Provide text, markdown or a file." }, { status: 400 });
  }

  const hints = (payload.hints && typeof payload.hints === "object" ? payload.hints : {}) as CompileInput["hints"];
  const overrides = (payload.overrides && typeof payload.overrides === "object" ? payload.overrides : null) as DraftOverrides | null;
  const preview = (payload.preview && typeof payload.preview === "object" ? payload.preview : null) as CompilePreview | null;

  // Everything compileKnowledge needs, resolved once — shared by the direct commit
  // and by the pending submission a non-approver's commit is parked as.
  const resolvedText = text || preview?.draft.teaching_core || "";
  const forceNew = payload.forceNew === true || payload.forceNew === "true";
  const dedupTargetRef = str(payload.dedupTargetRef, 32) || null;
  const confirmTruth = payload.confirmTruth === true || payload.confirmTruth === "true";
  const storeRaw =
    typeof payload.storeRaw === "boolean" ? payload.storeRaw : payload.storeRaw === "true" ? true : payload.storeRaw === "false" ? false : undefined;

  const db = supabaseAdmin();

  // APPROVAL GATE: a commit by someone who is NOT (super_admin OR documents:approve)
  // does not ingest. Park a pending submission carrying the full replay payload + the
  // compiled proposal, and return { pending } WITHOUT writing an ingestion_runs row or
  // calling compileKnowledge. Preview still runs for everyone (nothing is written).
  // Who-approves is resolved from the session, never the request body.
  if (mode === "commit" && !isApprover(admin)) {
    try {
      // Governance escalation is approver-only: a non-approver cannot silently set the
      // object's authority or founder endorsement, nor bypass the Company-Truth guard.
      const safeOverrides: DraftOverrides | null = overrides ? { ...overrides } : null;
      if (safeOverrides) {
        delete safeOverrides.authority;
        delete safeOverrides.founder_endorsement;
      }
      // Do NOT trust the client-supplied preview for the reviewer's view. Recompute the
      // proposal server-side with the (sanitised) edits already folded in, so the stored
      // preview is EXACTLY what the approver sees AND what replay will ingest — the client
      // can no longer show a benign proposal while different `overrides` / raw text go live.
      // With a client preview this reuses it (no extra model calls); otherwise it runs the
      // normal preview pipeline. It writes no chunk / document / object (mode "preview").
      const faithful = await compileKnowledge(db, {
        orgId: admin.orgId,
        intelligenceClass: cls,
        bucket,
        text: resolvedText,
        title: title || null,
        hints,
        overrides: safeOverrides,
        preview,
        mode: "preview",
        forceNew,
        dedupTargetRef,
        confirmTruth: false,
        storeRaw,
      });
      if (faithful.blocked) return Response.json({ error: faithful.blocked.reason }, { status: 422 });
      const reviewedPreview = faithful as CompilePreview;
      const reviewedDraft = reviewedPreview.draft as { teaching_core?: string; name?: string } | undefined;
      // The stored payload carries NO overrides, NO raw-archive lane and no truth
      // confirmation: on approve, replay ingests only the reviewed preview — nothing hidden.
      const submissionPayload: CompileSubmissionPayload = {
        intelligenceClass: cls,
        bucket,
        text: reviewedDraft?.teaching_core || resolvedText,
        title: title || null,
        hints,
        overrides: null,
        forceNew,
        dedupTargetRef,
        confirmTruth: false,
        storeRaw: false,
      };
      const submissionId = await writeSubmission(db, {
        orgId: admin.orgId,
        submittedBy: admin.memberId,
        submittedByEmail: admin.email,
        title: title || reviewedDraft?.name || null,
        kind: hasFile ? "file" : "paste",
        commitVia: "compile",
        intelligenceClass: cls,
        bucket,
        payload: submissionPayload,
        preview: reviewedPreview,
      });
      return Response.json({
        pending: true,
        submissionId,
        message: "Sent for approval — a super admin will review it before it goes live.",
      });
    } catch (e) {
      return dbError(e);
    }
  }

  let runId: string | null = null;
  if (mode === "commit") {
    const { data: run } = await db
      .from("ingestion_runs")
      .insert({ org_id: admin.orgId, trigger: "upload", status: "running" })
      .select("id")
      .single();
    runId = (run as { id?: string } | null)?.id ?? null;
  }

  try {
    const result = await compileKnowledge(db, {
      orgId: admin.orgId,
      intelligenceClass: cls,
      bucket,
      text: resolvedText,
      title: title || null,
      hints,
      overrides,
      preview,
      mode,
      forceNew,
      dedupTargetRef,
      confirmTruth,
      storeRaw,
      runId,
      createdBy: admin.email,
    });

    if (runId) {
      await db
        .from("ingestion_runs")
        .update({
          status: result.blocked ? "error" : "success",
          error: result.blocked?.reason ?? null,
          documents_ingested: result.object ? 1 : 0,
          documents_skipped: result.object ? 0 : 1,
          chunks_ingested: result.chunks,
          finished_at: new Date().toISOString(),
          ...(result.documentId ? { document_id: result.documentId } : {}),
        })
        .eq("id", runId)
        .then(() => {}, () => {});
    }

    // Keep the response bounded: the decision log is persisted; return a summary.
    return Response.json({
      ...result,
      log: result.log.map((e) => ({ stage: e.stage, decision: e.decision, model: e.model ?? null, confidence: e.confidence ?? null, durationMs: e.durationMs ?? null })),
    });
  } catch (e) {
    if (runId) {
      await db
        .from("ingestion_runs")
        .update({ status: "error", error: e instanceof Error ? e.message : "compile failed", finished_at: new Date().toISOString() })
        .eq("id", runId)
        .then(() => {}, () => {});
    }
    return dbError(e);
  }
}
