// POST /api/v1/learning — a trusted spoke saves a piece of Organizational
// Learning the Brain detected in chat (after the human confirmed it), or one the
// user recorded manually.
//
// Auth: scoped key with the 'chat' capability. The record is compiled like any
// knowledge object (class organizational_learning), gets a stable ref
// (DEC-014 / IMP-014 / RES-014 / LRN-014 …), a lifecycle row, and system edges
// to the playbooks it used. Evidence gaps the detector listed are kept on the
// record so a reviewer can complete it in the Learning Lab.
//
// Body: { kind, title, change, observedResult?, department?, relatedRefs?,
//         missingEvidence?, notes?, owner?, createdBy?, source? }
// Response: { ref, id, name, recordType, status }

import { supabaseAdmin } from "@/lib/supabase";
import { resolveContext, AuthError } from "@/lib/auth/context";
import { requireCapability } from "@/lib/auth/scope";
import { checkRateLimit, rateLimitHeaders } from "@/lib/ratelimit";
import { compileKnowledge } from "@/lib/knowledge-compiler";
import { isDemo } from "@/lib/demo/mode";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 60;

const KINDS = new Set(["decision", "implementation", "experiment", "result", "learning", "adaptation", "postmortem"]);

export async function POST(req: Request) {
  if (isDemo()) {
    return Response.json({ ref: "LRN-000", id: "demo", name: "Demo learning", recordType: "learning", status: "demo" });
  }

  let ctx;
  try {
    ctx = await resolveContext(req);
    requireCapability(ctx.key, "chat");
  } catch (e) {
    const err = e as AuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }
  const rl = checkRateLimit(ctx.key.id, ctx.key.rate_limit_per_min);
  if (!rl.ok) return Response.json({ error: "Rate limit exceeded." }, { status: 429, headers: rateLimitHeaders(rl) });

  const body = await req.json().catch(() => ({}));
  const str = (v: unknown, max = 4000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const kind = KINDS.has(str(body?.kind, 40)) ? str(body?.kind, 40) : "learning";
  const title = str(body?.title, 200);
  const change = str(body?.change);
  const observedResult = str(body?.observedResult);
  const department = str(body?.department, 120) || null;
  const notes = str(body?.notes, 8000);
  const owner = str(body?.owner, 120) || null;
  const relatedRefs = Array.isArray(body?.relatedRefs) ? (body.relatedRefs as unknown[]).map((r) => str(r, 32).toUpperCase()).filter(Boolean).slice(0, 10) : [];
  const missingEvidence = Array.isArray(body?.missingEvidence) ? (body.missingEvidence as unknown[]).map((r) => str(r, 300)).filter(Boolean).slice(0, 10) : [];
  if (!title && !change) return Response.json({ error: "title or change is required" }, { status: 400 });

  // The narrative the compiler turns into the canonical learning object.
  const text = [
    `# ${title || change.slice(0, 80)}`,
    "",
    `Record type: ${kind}`,
    department ? `Department / team: ${department}` : "",
    relatedRefs.length ? `Frameworks used: ${relatedRefs.join(", ")}` : "",
    "",
    "## What we changed / decided",
    change || title,
    observedResult ? `\n## Observed result\n${observedResult}` : "",
    notes ? `\n## Notes\n${notes}` : "",
    missingEvidence.length ? `\n## Missing evidence (to complete)\n${missingEvidence.map((m) => `- ${m}`).join("\n")}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");

  try {
    const res = await compileKnowledge(supabaseAdmin(), {
      orgId: ctx.orgId,
      intelligenceClass: "organizational_learning",
      text,
      title: title || undefined,
      mode: "commit",
      forceNew: true,
      storeRaw: false,
      createdBy: str(body?.createdBy, 200) || `key:${ctx.key.id}`,
      hints: {
        objectType: kind,
        department: undefined,
        learning: {
          recordType: kind,
          department,
          owner,
          relatedPlaybookRefs: relatedRefs,
          missingEvidence,
          confidence: missingEvidence.length ? "low" : "medium",
          source: body?.source === "manual" ? "manual" : "chat",
          lifecycleStatus: kind === "decision" ? "open" : kind === "implementation" ? "implementing" : kind === "experiment" ? "measuring" : missingEvidence.length ? "proposed" : "completed",
        },
      } as never,
    });
    if (res.blocked) return Response.json({ error: res.blocked.reason }, { status: 422 });
    const o = res.object ?? res.target;
    if (!o) return Response.json({ error: "Could not save the learning." }, { status: 500 });
    return Response.json({ ref: o.ref, id: o.id, name: o.name, recordType: kind, status: "saved" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "save failed";
    // Pre-migration: make the reason obvious to the operator.
    if (/knowledge_objects|does not exist|schema cache/i.test(msg)) {
      return Response.json({ error: "Organizational Learning needs Brain migration 0017 (knowledge_objects). Apply it and try again." }, { status: 503 });
    }
    return Response.json({ error: msg }, { status: 500 });
  }
}
