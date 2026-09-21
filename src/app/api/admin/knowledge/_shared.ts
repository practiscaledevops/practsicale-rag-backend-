// Shared helpers for the /api/admin/knowledge/* routes: admin guard → JSON error,
// object ref/name lookups for edge rendering, and a migration-missing hint.

import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
import type { AdminSession } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase";
import { isMissingRelation } from "@/lib/knowledge-store";

export const MIGRATION_HINT = "Operating Intelligence tables are missing — apply Brain migration 0017_operating_intelligence.sql.";

export async function guard(permission?: string): Promise<{ admin: AdminSession } | { response: Response }> {
  try {
    const admin = await requireAdmin(permission);
    return { admin };
  } catch (e) {
    const err = e as AdminAuthError;
    return { response: Response.json({ error: err.message }, { status: err.status ?? 401 }) };
  }
}

export function dbError(e: unknown): Response {
  const err = e as { code?: string; message?: string } | Error;
  const msg = err instanceof Error ? err.message : err?.message ?? "request failed";
  if (isMissingRelation(err as { code?: string; message?: string })) {
    return Response.json({ error: MIGRATION_HINT, migrationMissing: true }, { status: 503 });
  }
  return Response.json({ error: msg }, { status: 500 });
}

export interface ObjectStub {
  id: string;
  ref: string;
  name: string;
  intelligence_class: string;
  domain: string;
  object_type: string;
  status: string;
}

/** ref/name/class for a set of object ids (for edges, mentions, logs). */
export async function objectStubs(orgId: string, ids: string[]): Promise<Record<string, ObjectStub>> {
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  const out: Record<string, ObjectStub> = {};
  if (!uniq.length) return out;
  const { data } = await supabaseAdmin()
    .from("knowledge_objects")
    .select("id, ref, name, intelligence_class, domain, object_type, status")
    .eq("org_id", orgId)
    .in("id", uniq);
  for (const o of (data ?? []) as ObjectStub[]) out[o.id] = o;
  return out;
}

export function str(v: unknown, max = 2000): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A uuid from a route/query/body value, or "" — ids are interpolated into PostgREST filters, so never pass free text. */
export function uuid(v: unknown): string {
  const s = str(v, 64);
  return UUID_RE.test(s) ? s.toLowerCase() : "";
}
export function strOrNull(v: unknown, max = 2000): string | null {
  const s = str(v, max);
  return s ? s : null;
}
export function strList(v: unknown, max = 40): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x, 120)).filter(Boolean).slice(0, max);
}
export function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
