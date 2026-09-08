// GET / PUT /api/admin/settings — the RAG pipeline Settings surface.
//
// Admin-only (dashboard session). org_id is resolved SERVER-SIDE from the admin
// session, so an admin only ever reads/writes their own tenant's settings.
//
//   GET  — the org's RagSettings (merged over defaults) + when it was last saved.
//   PUT  — replace the org's settings (normalized through mergeSettings).
//
// Settings live in app_settings.data (jsonb), so changing a knob here changes the
// pipeline's behaviour live — no redeploy (same model as the Prompt Studio).

import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from "@/lib/settings";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

function authErrorResponse(e: unknown): Response {
  const err = e as AdminAuthError;
  return Response.json({ error: err.message }, { status: err.status ?? 401 });
}

export async function GET() {
  let admin;
  try {
    admin = await requireAdmin("settings:read");
  } catch (e) {
    return authErrorResponse(e);
  }
  const { settings, updatedAt } = await loadSettings(admin.orgId);
  return Response.json({ settings, defaults: DEFAULT_SETTINGS, updatedAt });
}

export async function PUT(req: Request) {
  let admin;
  try {
    admin = await requireAdmin("settings:write");
  } catch (e) {
    return authErrorResponse(e);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Accept either { settings: {...} } or a bare settings object.
  const raw =
    body && typeof body === "object" && "settings" in (body as Record<string, unknown>)
      ? (body as Record<string, unknown>).settings
      : body;

  const settings = await saveSettings(admin.orgId, raw, admin.memberId);
  return Response.json({ settings });
}
