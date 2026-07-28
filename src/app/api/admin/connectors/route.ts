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

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

// Matches the connectors kind check (0007).
const KINDS = ["mcp", "http_api"] as const;
type Kind = (typeof KINDS)[number];

const CONNECTOR_COLUMNS =
  "id, name, slug, kind, config, auth_secret_ref, is_active, created_at";

function guard(e: unknown): Response {
  const err = e as AdminAuthError;
  return Response.json({ error: err.message }, { status: err.status ?? 401 });
}

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

// POST — create a connector, or (action: "grant") grant one to an api_key.
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

// DELETE — revoke a grant (?grant_id=...). Removes a key's access to a connector.
export async function DELETE(req: Request) {
  let admin;
  try {
    admin = await requireAdmin("connectors:write");
  } catch (e) {
    return guard(e);
  }

  const grantId = new URL(req.url).searchParams.get("grant_id");
  if (!grantId) {
    return Response.json({ error: "A grant_id is required" }, { status: 400 });
  }

  const db = supabaseAdmin();
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
