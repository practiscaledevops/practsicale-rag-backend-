import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
import { supabaseAdmin } from "@/lib/supabase";
import { documentRevision } from "@/lib/document-revision";
export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
const headers = { "cache-control": "private, no-store" };
export async function GET() {
  try {
    const admin = await requireAdmin("documents:read");
    return Response.json({ version: await documentRevision(supabaseAdmin(), admin.orgId) }, { headers });
  } catch (e) {
    if (e instanceof AdminAuthError) return Response.json({ error: e.message }, { status: e.status, headers });
    return Response.json({ error: "Live document updates are temporarily unavailable" }, { status: 503, headers });
  }
}
