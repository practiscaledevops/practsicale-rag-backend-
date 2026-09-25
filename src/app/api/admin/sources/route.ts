// GET   /api/admin/sources — list this org's registered data sources.
// POST  /api/admin/sources — register a new PULL (pull_http) data source.
// PATCH /api/admin/sources — bulk pause / resume: { ids: uuid[] (1..200), is_active }.
//
// org_id is resolved SERVER-SIDE from the admin session (never from the request
// body) and every query is filtered by it, so a request can only ever read,
// create or change sources within the caller's own tenant.
//
// SECURITY: a source stores only a REFERENCE to where its secret lives
// (auth_secret_ref = the NAME of a server env var), never the secret itself. The
// pull runner (src/lib/connectors/pull.ts) reads that env var server-side at run
// time.

import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
import { isAllowedSecretRef, SECRET_REF_RULE } from "@/lib/connectors/secret-ref";
import { isDemo } from "@/lib/demo/mode";
import { BULK_MAX_IDS } from "@/lib/bulk";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
// PATCH is one set-based UPDATE; GET / POST are single queries.
export const maxDuration = 60;

// Mirrors the data_sources.source_type / auth_type / http_method CHECK constraints.
const SOURCE_TYPES = ["transcript", "call_score", "coaching", "document"];
const AUTH_TYPES = ["none", "bearer", "api_key", "basic"];
const HTTP_METHODS = ["GET", "POST"];

// Columns returned to the dashboard. Note we DO surface auth_secret_ref (the env
// var NAME) — it is not a secret, and admins need to see which var a source uses.
const SELECT =
  "id, name, slug, source_type, kind, endpoint_url, http_method, auth_type, " +
  "auth_secret_ref, records_path, record_id_field, cursor_field, cursor_param, cursor_value, query_params, schedule_cron, " +
  "is_active, last_run_at, last_status, created_at";

/** URL-safe slug from a display name (used for the unique (org_id, slug) key). */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function GET() {
  let admin;
  try {
    admin = await requireAdmin("data_sources:read");
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("data_sources")
    .select(SELECT)
    .eq("org_id", admin.orgId)
    .order("created_at", { ascending: false });

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ sources: data ?? [] });
}

export async function POST(req: Request) {
  let admin;
  try {
    admin = await requireAdmin("data_sources:write");
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const asStr = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const name = asStr(body.name);
  const sourceType = asStr(body.source_type);
  const endpointUrl = asStr(body.endpoint_url);
  const httpMethod = (asStr(body.http_method) || "GET").toUpperCase();
  const authType = asStr(body.auth_type) || "none";
  const authSecretRef = asStr(body.auth_secret_ref);
  const recordsPath = asStr(body.records_path);
  const recordIdField = asStr(body.record_id_field);
  const cursorField = asStr(body.cursor_field);
  const cursorParam = asStr(body.cursor_param);
  const scheduleCron = asStr(body.schedule_cron);

  // --- Validation -----------------------------------------------------------
  if (!name) return Response.json({ error: "Name is required" }, { status: 400 });
  if (!SOURCE_TYPES.includes(sourceType)) {
    return Response.json(
      { error: `source_type must be one of: ${SOURCE_TYPES.join(", ")}` },
      { status: 400 }
    );
  }
  if (!HTTP_METHODS.includes(httpMethod)) {
    return Response.json(
      { error: `http_method must be one of: ${HTTP_METHODS.join(", ")}` },
      { status: 400 }
    );
  }
  if (!AUTH_TYPES.includes(authType)) {
    return Response.json(
      { error: `auth_type must be one of: ${AUTH_TYPES.join(", ")}` },
      { status: 400 }
    );
  }
  // A pull_http source must have a reachable http(s) endpoint.
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    return Response.json({ error: "endpoint_url must be a valid URL" }, { status: 400 });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Response.json({ error: "endpoint_url must be http(s)" }, { status: 400 });
  }
  // Any auth beyond 'none' needs the env-var reference that holds the secret —
  // and it may only name a connector credential, never a platform secret (the
  // runner would otherwise send that secret to whatever endpoint_url says).
  if (authType !== "none" && !authSecretRef) {
    return Response.json(
      { error: "auth_secret_ref (the server env-var name that holds the secret) is required for this auth type" },
      { status: 400 }
    );
  }
  if (authSecretRef && !isAllowedSecretRef(authSecretRef)) {
    return Response.json({ error: SECRET_REF_RULE }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("data_sources")
    .insert({
      org_id: admin.orgId, // tenant is the session's org — never client input
      name,
      slug: slugify(name) || null,
      source_type: sourceType,
      kind: "pull_http",
      endpoint_url: endpointUrl,
      http_method: httpMethod,
      auth_type: authType,
      auth_secret_ref: authSecretRef || null,
      records_path: recordsPath || null,
      record_id_field: recordIdField || null,
      cursor_field: cursorField || null,
      cursor_param: cursorParam || null,
      schedule_cron: scheduleCron || null,
      created_by: admin.memberId,
    })
    .select(SELECT)
    .single();

  if (error) {
    // Unique (org_id, slug) violation -> a source with this name already exists.
    if ((error as { code?: string }).code === "23505") {
      return Response.json(
        { error: `A data source named "${name}" already exists.` },
        { status: 409 }
      );
    }
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ source: data }, { status: 201 });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The in-memory demo store uses short ids ("src-1"); only demo mode accepts them.
const DEMO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A bulk id list from the request body: 1..BULK_MAX_IDS unique UUIDs. The ids
 * go into a PostgREST `in` filter, so free text is rejected, not passed through.
 */
function parseIds(v: unknown): { ids: string[] } | { error: string } {
  if (!Array.isArray(v) || v.length === 0) return { error: "ids must be a non-empty array of source ids" };
  const re = isDemo() ? DEMO_ID_RE : UUID_RE;
  if (!v.every((x): x is string => typeof x === "string" && re.test(x))) {
    return { error: "ids must be UUIDs" };
  }
  // Dedupe case-insensitively, keeping the caller's first spelling.
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of v as string[]) {
    const k = id.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    ids.push(id);
  }
  if (ids.length > BULK_MAX_IDS) return { error: `At most ${BULK_MAX_IDS} ids per request` };
  return { ids };
}

// PATCH — pause or resume many sources at once (the list's bulk bar).
//
//   { ids: uuid[] (1..200), is_active: boolean }
//
// ONE UPDATE … WHERE id IN (…) AND org_id = <session org>, the same change the
// single PATCH /api/admin/sources/[id] makes per row. Ids that are not in this
// org (or do not exist) come back in `failed`; the rest in `ids`.
export async function PATCH(req: Request) {
  let admin;
  try {
    admin = await requireAdmin("data_sources:write");
  } catch (e) {
    const err = e as AdminAuthError;
    return Response.json({ error: err.message }, { status: err.status ?? 401 });
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsedIds = parseIds(body.ids);
  if ("error" in parsedIds) return Response.json({ error: parsedIds.error }, { status: 400 });
  if (typeof body.is_active !== "boolean") {
    return Response.json({ error: "is_active must be true or false" }, { status: 400 });
  }
  const { ids } = parsedIds;
  const isActive = body.is_active;

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("data_sources")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .in("id", ids)
    .eq("org_id", admin.orgId) // tenant scope: never the body's org
    .select("id, is_active");

  if (error) return Response.json({ error: error.message }, { status: 500 });

  // Postgres returns lower-case uuids: report back in the caller's spelling.
  const done = new Set(((data ?? []) as { id: string }[]).map((r) => String(r.id).toLowerCase()));
  const updated = ids.filter((id) => done.has(id.toLowerCase()));
  const failed = ids
    .filter((id) => !done.has(id.toLowerCase()))
    .map((id) => ({ id, error: "Data source not found" }));

  return Response.json({ ok: true, ids: updated, failed, is_active: isActive });
}
