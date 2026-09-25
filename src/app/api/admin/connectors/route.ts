// GET / POST / DELETE  /api/admin/connectors — admin management of the connectors
// registry and per-key grants.
//
// Admin-only (dashboard session). org_id is resolved SERVER-SIDE from the admin
// session — never from the request body — and every query is filtered by it, so a
// request can only ever touch connectors / keys in the caller's own tenant.
//
// A connector is an external integration (an MCP server or a third-party HTTP API)
// that a consumer app can be granted via its scoped key. `auth_secret_ref` stores
// a REFERENCE to where the secret lives (env var / vault key), never the secret.

import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
import { isDemo } from "@/lib/demo/mode";
import { BULK_MAX_IDS } from "@/lib/bulk";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

// Matches the connectors kind check (0007).
const KINDS = ["mcp", "http_api"] as const;
type Kind = (typeof KINDS)[number];

const CONNECTOR_COLUMNS =
  "id, name, slug, kind, config, auth_secret_ref, is_active, created_at";

/** Most keys one bulk grant request may name. */
const GRANT_MAX_KEYS = 50;

type Db = ReturnType<typeof supabaseAdmin>;
type GrantRow = { id: string; connector_id: string; api_key_id: string };

function guard(e: unknown): Response {
  const err = e as AdminAuthError;
  return Response.json({ error: err.message }, { status: err.status ?? 401 });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The in-memory demo store uses short ids ("key-1"); only demo mode accepts them.
const DEMO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A bulk id list from the request body: 1..max unique UUIDs. The ids go into a
 * PostgREST `in` filter, so free text is rejected rather than passed through.
 */
function parseIds(v: unknown, field: string, max: number): { ids: string[] } | { error: string } {
  if (!Array.isArray(v) || v.length === 0) return { error: `${field} must be a non-empty array of ids` };
  if (v.length > max) return { error: `At most ${max} ${field} per request` };
  const re = isDemo() ? DEMO_ID_RE : UUID_RE;
  if (!v.every((x): x is string => typeof x === "string" && re.test(x))) {
    return { error: `${field} must be UUIDs` };
  }
  return { ids: Array.from(new Set(v as string[])) };
}

const lower = (s: string) => s.toLowerCase();

/** name -> url-safe slug (nullable; the DB allows several null slugs per org). */
function slugify(name: string): string | null {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || null;
}

// GET — connectors (each with its grants) plus the api_keys available to grant to.
export async function GET() {
  let admin;
  try {
    admin = await requireAdmin("connectors:read");
  } catch (e) {
    return guard(e);
  }

  const db = supabaseAdmin();
  const [connectors, grants, keys] = await Promise.all([
    db
      .from("connectors")
      .select(CONNECTOR_COLUMNS)
      .eq("org_id", admin.orgId)
      .order("created_at", { ascending: false }),
    db
      .from("connector_grants")
      .select("id, connector_id, api_key_id")
      .eq("org_id", admin.orgId),
    db
      .from("api_keys")
      .select("id, name, key_prefix, revoked_at")
      .eq("org_id", admin.orgId)
      .order("created_at", { ascending: false }),
  ]);

  if (connectors.error) {
    return Response.json({ error: connectors.error.message }, { status: 500 });
  }

  // Index keys so grants can carry a human label (name + prefix) for the UI.
  const keyById = new Map(
    (keys.data ?? []).map((k: { id: string; name: string | null; key_prefix: string | null }) => [
      k.id,
      k,
    ])
  );

  const grantsByConnector = new Map<string, unknown[]>();
  for (const g of (grants.data ?? []) as {
    id: string;
    connector_id: string;
    api_key_id: string;
  }[]) {
    const key = keyById.get(g.api_key_id);
    const list = grantsByConnector.get(g.connector_id) ?? [];
    list.push({
      id: g.id,
      api_key_id: g.api_key_id,
      key_name: key?.name ?? null,
      key_prefix: key?.key_prefix ?? null,
    });
    grantsByConnector.set(g.connector_id, list);
  }

  const withGrants = (connectors.data ?? []).map((c: { id: string }) => ({
    ...c,
    grants: grantsByConnector.get(c.id) ?? [],
  }));

  return Response.json({ connectors: withGrants, apiKeys: keys.data ?? [], kinds: KINDS });
}

// POST — create a connector, or (action: "grant") grant one to api keys:
//   { action: "grant", connector_id, api_key_id }          one key (unchanged)
//   { action: "grant", connector_id, api_key_ids: uuid[] } up to 50 keys at once;
//     keys not in this org or revoked come back in `failed`, keys that already
//     hold the grant count as granted (listed in `alreadyGranted`).
export async function POST(req: Request) {
  let admin;
  try {
    admin = await requireAdmin("connectors:write");
  } catch (e) {
    return guard(e);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const db = supabaseAdmin();

  // --- Grant a connector to a key -------------------------------------------
  if (body.action === "grant") {
    const connectorId = typeof body.connector_id === "string" ? body.connector_id : "";
    if (body.api_key_ids !== undefined) {
      return grantMany(db, admin.orgId, connectorId, body.api_key_ids);
    }
    const apiKeyId = typeof body.api_key_id === "string" ? body.api_key_id : "";
    if (!connectorId || !apiKeyId) {
      return Response.json(
        { error: "connector_id and api_key_id are required" },
        { status: 400 }
      );
    }

    // Both sides must belong to this org.
    const [conn, key] = await Promise.all([
      db
        .from("connectors")
        .select("id")
        .eq("id", connectorId)
        .eq("org_id", admin.orgId)
        .maybeSingle(),
      db
        .from("api_keys")
        .select("id")
        .eq("id", apiKeyId)
        .eq("org_id", admin.orgId)
        .maybeSingle(),
    ]);
    if (!conn.data) {
      return Response.json({ error: "Connector not found" }, { status: 404 });
    }
    if (!key.data) {
      return Response.json({ error: "API key not found" }, { status: 404 });
    }

    const { data, error } = await db
      .from("connector_grants")
      .insert({ org_id: admin.orgId, connector_id: connectorId, api_key_id: apiKeyId })
      .select("id, connector_id, api_key_id")
      .single();

    // Unique (connector_id, api_key_id) violation => already granted; treat as OK.
    if (error) {
      if (error.code === "23505") {
        return Response.json({ granted: true, alreadyGranted: true });
      }
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ grant: data, granted: true }, { status: 201 });
  }

  // --- Create a connector ----------------------------------------------------
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return Response.json({ error: "A connector name is required" }, { status: 400 });
  }

  const kind = body.kind;
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
    return Response.json(
      { error: "kind must be 'mcp' or 'http_api'" },
      { status: 400 }
    );
  }

  // config may arrive as an object or a JSON string. Must resolve to an object.
  let config: unknown = body.config ?? {};
  if (typeof config === "string") {
    if (config.trim() === "") {
      config = {};
    } else {
      try {
        config = JSON.parse(config);
      } catch {
        return Response.json({ error: "config must be valid JSON" }, { status: 400 });
      }
    }
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return Response.json(
      { error: "config must be a JSON object" },
      { status: 400 }
    );
  }

  const authSecretRef =
    typeof body.auth_secret_ref === "string" && body.auth_secret_ref.trim() !== ""
      ? body.auth_secret_ref.trim()
      : null;

  const { data, error } = await db
    .from("connectors")
    .insert({
      org_id: admin.orgId,
      name,
      slug: slugify(name),
      kind: kind as Kind,
      config,
      auth_secret_ref: authSecretRef,
      created_by: admin.memberId,
    })
    .select(CONNECTOR_COLUMNS)
    .single();

  if (error) {
    // Unique (org_id, slug) violation => a similarly-named connector exists.
    if (error.code === "23505") {
      return Response.json(
        { error: "A connector with a similar name already exists" },
        { status: 409 }
      );
    }
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ connector: { ...data, grants: [] } }, { status: 201 });
}

/**
 * Bulk grant: verify the connector and every key in this org (unrevoked), then
 * ONE insert … on conflict do nothing, then read back the grants so the caller
 * gets a grant id for every key (new or already granted).
 */
async function grantMany(db: Db, orgId: string, connectorId: string, rawKeyIds: unknown): Promise<Response> {
  if (!connectorId) {
    return Response.json({ error: "connector_id is required" }, { status: 400 });
  }
  if (!(isDemo() ? DEMO_ID_RE : UUID_RE).test(connectorId)) {
    return Response.json({ error: "connector_id must be a UUID" }, { status: 400 });
  }
  const parsed = parseIds(rawKeyIds, "api_key_ids", GRANT_MAX_KEYS);
  if ("error" in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  const { ids } = parsed;

  const [conn, keys] = await Promise.all([
    db
      .from("connectors")
      .select("id")
      .eq("id", connectorId)
      .eq("org_id", orgId)
      .maybeSingle(),
    db
      .from("api_keys")
      .select("id, revoked_at")
      .eq("org_id", orgId) // tenant scope
      .in("id", ids),
  ]);
  if (conn.error || keys.error) {
    return Response.json({ error: (conn.error ?? keys.error)!.message }, { status: 500 });
  }
  if (!conn.data) {
    return Response.json({ error: "Connector not found" }, { status: 404 });
  }

  const keyById = new Map(
    ((keys.data ?? []) as { id: string; revoked_at: string | null }[]).map((k) => [lower(k.id), k])
  );
  const failed: { id: string; error: string }[] = [];
  const eligible: string[] = [];
  for (const id of ids) {
    const key = keyById.get(lower(id));
    if (!key) failed.push({ id, error: "API key not found" });
    else if (key.revoked_at) failed.push({ id, error: "API key is revoked" });
    else eligible.push(id);
  }
  if (eligible.length === 0) {
    return Response.json({ granted: [], grants: [], alreadyGranted: [], failed });
  }

  // Unique (connector_id, api_key_id): keys that already hold the grant are skipped.
  const ins = await db
    .from("connector_grants")
    .upsert(
      eligible.map((api_key_id) => ({ org_id: orgId, connector_id: connectorId, api_key_id })),
      { onConflict: "connector_id,api_key_id", ignoreDuplicates: true }
    )
    .select("id");
  if (ins.error) {
    return Response.json({ error: ins.error.message }, { status: 500 });
  }
  const created = new Set(((ins.data ?? []) as { id: string }[]).map((g) => g.id));

  const after = await db
    .from("connector_grants")
    .select("id, connector_id, api_key_id")
    .eq("org_id", orgId)
    .eq("connector_id", connectorId)
    .in("api_key_id", eligible);
  if (after.error) {
    return Response.json({ error: after.error.message }, { status: 500 });
  }

  const grantByKey = new Map(((after.data ?? []) as GrantRow[]).map((g) => [lower(g.api_key_id), g]));
  const granted: string[] = [];
  const alreadyGranted: string[] = [];
  const grants: GrantRow[] = [];
  for (const id of eligible) {
    const g = grantByKey.get(lower(id));
    if (!g) {
      failed.push({ id, error: "Grant failed" });
      continue;
    }
    granted.push(id);
    if (!created.has(g.id)) alreadyGranted.push(id);
    grants.push({ ...g, api_key_id: id });
  }

  return Response.json({ granted, grants, alreadyGranted, failed }, { status: created.size > 0 ? 201 : 200 });
}

// DELETE — revoke grants. Removes keys' access to a connector.
//   ?grant_id=<uuid>                  one grant (the original contract, unchanged).
//   JSON body { grant_ids: uuid[] }   up to 200 grants in ONE org-scoped delete;
//                                     ids not found in this org come back in `failed`.
export async function DELETE(req: Request) {
  let admin;
  try {
    admin = await requireAdmin("connectors:write");
  } catch (e) {
    return guard(e);
  }

  const db = supabaseAdmin();
  const grantId = new URL(req.url).searchParams.get("grant_id");
  if (!grantId) {
    // No ?grant_id=: the bulk form, when the body carries `grant_ids`.
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // No body, or not JSON: the "grant_id required" error below.
    }
    if (!body || body.grant_ids === undefined) {
      return Response.json({ error: "A grant_id is required" }, { status: 400 });
    }
    return removeMany(db, admin.orgId, body.grant_ids);
  }

  const { data, error } = await db
    .from("connector_grants")
    .delete()
    .eq("id", grantId)
    .eq("org_id", admin.orgId) // tenant scope
    .select("id")
    .maybeSingle();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return Response.json({ error: "Grant not found" }, { status: 404 });
  }

  return Response.json({ id: data.id, removed: true });
}

/** Bulk ungrant: one DELETE … WHERE id IN (…) AND org_id = <session org>. */
async function removeMany(db: Db, orgId: string, rawIds: unknown): Promise<Response> {
  const parsed = parseIds(rawIds, "grant_ids", BULK_MAX_IDS);
  if ("error" in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  const { ids } = parsed;

  const { data, error } = await db
    .from("connector_grants")
    .delete()
    .in("id", ids)
    .eq("org_id", orgId) // tenant scope
    .select("id");

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  // Postgres returns lower-case uuids: report back in the caller's spelling.
  const done = new Set(((data ?? []) as { id: string }[]).map((r) => lower(r.id)));
  const removed = ids.filter((id) => done.has(lower(id)));
  const failed = ids
    .filter((id) => !done.has(lower(id)))
    .map((id) => ({ id, error: "Grant not found" }));

  return Response.json({ removed, failed });
}
