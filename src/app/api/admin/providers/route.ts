// GET / PUT / DELETE /api/admin/providers — manage platform provider API keys
// (OpenAI, Anthropic, Cohere) from the dashboard.
//
// SUPER-ADMIN ONLY: provider keys are platform-wide credentials, not per-tenant,
// so only a super_admin may view their status or change them. Secrets are stored
// encrypted (see lib/secrets) and NEVER returned to the browser — GET returns a
// masked status only (configured?, source, last4).
//
//   GET    -> { providers: [{ provider, configured, source, last4, updatedAt }] }
//   PUT    -> set/rotate a key: { provider, secret }
//   DELETE -> clear a DB key (falls back to env): ?provider= or { provider }

import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
import {
  listProviderStatus,
  setProviderKey,
  deleteProviderKey,
  PROVIDERS,
  type Provider,
} from "@/lib/secrets";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

function authError(e: unknown): Response {
  const err = e as AdminAuthError;
  return Response.json({ error: err.message }, { status: err.status ?? 401 });
}

function isProvider(v: unknown): v is Provider {
  return typeof v === "string" && (PROVIDERS as string[]).includes(v);
}

/** Provider keys are platform-level — require a super_admin. */
async function requireSuperAdmin() {
  const admin = await requireAdmin();
  if (admin.role !== "super_admin") {
    throw new AdminAuthError("Only a super admin can manage provider keys", 403);
  }
  return admin;
}

export async function GET() {
  try {
    await requireSuperAdmin();
  } catch (e) {
    return authError(e);
  }
  return Response.json({ providers: await listProviderStatus() });
}

export async function PUT(req: Request) {
  let admin;
  try {
    admin = await requireSuperAdmin();
  } catch (e) {
    return authError(e);
  }

  let body: { provider?: unknown; secret?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isProvider(body.provider)) {
    return Response.json({ error: `provider must be one of: ${PROVIDERS.join(", ")}` }, { status: 400 });
  }
  const secret = typeof body.secret === "string" ? body.secret.trim() : "";
  if (!secret) return Response.json({ error: "secret is required" }, { status: 400 });

  await setProviderKey(body.provider, secret, admin.memberId);
  return Response.json({ providers: await listProviderStatus() });
}

export async function DELETE(req: Request) {
  try {
    await requireSuperAdmin();
  } catch (e) {
    return authError(e);
  }

  const url = new URL(req.url);
  let provider = url.searchParams.get("provider");
  if (!provider) {
    const body = await req.json().catch(() => ({}));
    provider = typeof body?.provider === "string" ? body.provider : null;
  }
  if (!isProvider(provider)) {
    return Response.json({ error: `provider must be one of: ${PROVIDERS.join(", ")}` }, { status: 400 });
  }

  await deleteProviderKey(provider);
  return Response.json({ providers: await listProviderStatus() });
}
