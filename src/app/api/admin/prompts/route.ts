// GET / POST / PATCH /api/admin/prompts — the Prompt Studio's admin API.
//
// Admin-only (dashboard session). org_id is resolved SERVER-SIDE from the admin
// session (never from the request body) and every query is filtered by it, so an
// admin can only ever read or change prompts that belong to their own tenant.
//
//   GET   — list this org's prompts (use_case, version, is_active, content).
//   POST  — create a new version for a use_case (optionally activate it).
//   PATCH — activate one version; deactivates every other version of the same
//           use_case in the org so exactly one is active per use_case.
//
// Prompts are versioned snapshots: "editing" a prompt means saving a NEW version,
// never mutating an existing row. That keeps a full, auditable history and lets
// the dashboard change assistant behaviour without a redeploy.

import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

interface PromptRow {
  id: string;
  use_case: string;
  version: number;
  content: string;
  is_active: boolean;
  created_at: string;
}

const PROMPT_COLUMNS = "id, use_case, version, content, is_active, created_at";

/** Turn a requireAdmin() rejection into a 401/403 JSON response. */
function authErrorResponse(e: unknown): Response {
  const err = e as AdminAuthError;
  return Response.json({ error: err.message }, { status: err.status ?? 401 });
}

// GET — list the org's prompts, newest version first within each use_case.
export async function GET() {
  let admin;
  try {
    admin = await requireAdmin("prompts:read");
  } catch (e) {
    return authErrorResponse(e);
  }

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("prompts")
    .select(PROMPT_COLUMNS)
    .eq("org_id", admin.orgId)
    .order("use_case", { ascending: true })
    .order("version", { ascending: false });

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ prompts: (data ?? []) as PromptRow[] });
}

// POST — create a new version for a use_case.
// Body: { use_case: string, content: string, activate?: boolean }
export async function POST(req: Request) {
  let admin;
  try {
    admin = await requireAdmin("prompts:write");
  } catch (e) {
    return authErrorResponse(e);
  }

  let body: { use_case?: unknown; content?: unknown; activate?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const useCase = typeof body.use_case === "string" ? body.use_case.trim() : "";
  const content = typeof body.content === "string" ? body.content : "";
  const activate = body.activate === true;

  if (!useCase) {
    return Response.json({ error: "use_case is required" }, { status: 400 });
  }
  if (!content.trim()) {
    return Response.json({ error: "content is required" }, { status: 400 });
  }

  const db = supabaseAdmin();

  // Next version = current max for this use_case in the org, + 1 (1 if none yet).
  const { data: latest, error: latestErr } = await db
    .from("prompts")
    .select("version")
    .eq("org_id", admin.orgId)
    .eq("use_case", useCase)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestErr) return Response.json({ error: latestErr.message }, { status: 500 });
  const nextVersion = (latest?.version ?? 0) + 1;

  // If this version becomes active, deactivate the others first so exactly one
  // version per use_case is ever active in the org.
  if (activate) {
    const { error: deErr } = await db
      .from("prompts")
      .update({ is_active: false })
      .eq("org_id", admin.orgId)
      .eq("use_case", useCase);
    if (deErr) return Response.json({ error: deErr.message }, { status: 500 });
  }

  const { data: created, error: insErr } = await db
    .from("prompts")
    .insert({
      org_id: admin.orgId,
      use_case: useCase,
      version: nextVersion,
      content,
      is_active: activate, // explicit: the table default is true, we never want that
    })
    .select(PROMPT_COLUMNS)
    .single();

  if (insErr) return Response.json({ error: insErr.message }, { status: 500 });
  return Response.json({ prompt: created as PromptRow }, { status: 201 });
}

// PATCH — activate one version, deactivating all other versions of the same
// use_case in the org.
// Body: { id: string }
export async function PATCH(req: Request) {
  let admin;
  try {
    admin = await requireAdmin("prompts:write");
  } catch (e) {
    return authErrorResponse(e);
  }

  let body: { id?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  const db = supabaseAdmin();

  // Load the target within the org, both to authorize (tenant check) and to learn
  // which use_case's versions to deactivate.
  const { data: target, error: findErr } = await db
    .from("prompts")
    .select("id, use_case")
    .eq("id", id)
    .eq("org_id", admin.orgId)
    .maybeSingle();

  if (findErr) return Response.json({ error: findErr.message }, { status: 500 });
  if (!target) return Response.json({ error: "Prompt not found" }, { status: 404 });

  // Deactivate every version of this use_case in the org, then activate the one.
  // Two statements leave a sub-millisecond window with none active; acceptable for
  // a single-admin back office, and it never leaves two active.
  const { error: deErr } = await db
    .from("prompts")
    .update({ is_active: false })
    .eq("org_id", admin.orgId)
    .eq("use_case", target.use_case);
  if (deErr) return Response.json({ error: deErr.message }, { status: 500 });

  const { data: updated, error: upErr } = await db
    .from("prompts")
    .update({ is_active: true })
    .eq("id", id)
    .eq("org_id", admin.orgId)
    .select(PROMPT_COLUMNS)
    .single();

  if (upErr) return Response.json({ error: upErr.message }, { status: 500 });
  return Response.json({ prompt: updated as PromptRow });
}
