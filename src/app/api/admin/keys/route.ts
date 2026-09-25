// GET / POST / DELETE  /api/admin/keys — admin management of scoped API keys.
//
// Admin-only (dashboard session). org_id is resolved SERVER-SIDE from the admin
// session — never from the request body. Every query is filtered by that org, so
// a request can only ever touch keys / sources / collections in the caller's own
// tenant.
//
// Secret handling (master plan §0.6): the plaintext key is generated HERE, shown
// to the admin ONCE in the POST response, and NEVER stored or logged. We persist
// only a non-secret prefix (for lookup + display) and a SHA-256 hash.

import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
import { generateApiKey } from "@/lib/auth/keys";
import { isDemo } from "@/lib/demo/mode";
import { BULK_MAX_IDS } from "@/lib/bulk";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

// The capabilities a key can grant, and the data types it can be scoped to. Kept
// in sync with the api_keys capabilities check (0005) and the data_sources
// source_type check (0006).
const CAPABILITIES = ["chat", "retrieve", "generate"] as const;
const SOURCE_TYPES = ["call_score", "coaching", "document", "transcript"] as const;

type Capability = (typeof CAPABILITIES)[number];
type SourceType = (typeof SOURCE_TYPES)[number];

// Columns safe to return to the dashboard — never key_hash.
const KEY_COLUMNS =
  "id, name, key_prefix, capabilities, source_types, data_source_ids, collection_ids, rate_limit_per_min, expires_at, revoked_at, last_used_at, request_count, created_at";

type Db = ReturnType<typeof supabaseAdmin>;

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

/** Dedupe an unknown value into a string[] (non-strings dropped). */
function uniqueStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return Array.from(new Set(v.filter((x): x is string => typeof x === "string")));
}

/**
 * Keep only the ids that actually belong to this org. Prevents a client from
 * injecting another tenant's data-source / collection id into a key's scope.
 */
async function filterOrgIds(
  db: Db,
  table: "data_sources" | "collections",
  orgId: string,
  ids: unknown
): Promise<string[]> {
  const wanted = uniqueStrings(ids);
  if (wanted.length === 0) return [];
  const { data } = await db
    .from(table)
    .select("id")
    .eq("org_id", orgId)
    .in("id", wanted);
  return (data ?? []).map((r: { id: string }) => r.id);
}

// GET — list this org's keys, plus the data sources and collections available to
// scope a new key against (so the create dialog can render its pickers).
export async function GET() {
  let admin;
  try {
    admin = await requireAdmin("api_keys:read");
  } catch (e) {
    return guard(e);
  }

  const db = supabaseAdmin();
  const [keys, dataSources, collections] = await Promise.all([
    db
      .from("api_keys")
      .select(KEY_COLUMNS)
      .eq("org_id", admin.orgId)
      .order("created_at", { ascending: false }),
    db
      .from("data_sources")
      .select("id, name, source_type")
      .eq("org_id", admin.orgId)
      .order("name"),
    db.from("collections").select("id, name").eq("org_id", admin.orgId).order("name"),
  ]);

  if (keys.error) {
    return Response.json({ error: keys.error.message }, { status: 500 });
  }

  return Response.json({
    keys: keys.data ?? [],
    dataSources: dataSources.data ?? [],
    collections: collections.data ?? [],
    sourceTypes: SOURCE_TYPES,
    capabilities: CAPABILITIES,
  });
}

// POST — mint a new scoped key. Returns the plaintext secret exactly once.
export async function POST(req: Request) {
  let admin;
  try {
    admin = await requireAdmin("api_keys:write");
  } catch (e) {
    return guard(e);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return Response.json({ error: "A key name is required" }, { status: 400 });
  }

  // Capabilities: at least one, all drawn from the known set.
  const capabilities = uniqueStrings(body.capabilities).filter(
    (c): c is Capability => (CAPABILITIES as readonly string[]).includes(c)
  );
  if (capabilities.length === 0) {
    return Response.json({ error: "Select at least one capability" }, { status: 400 });
  }

  // Source types: any subset of the known set. Empty means "all types in scope".
  const sourceTypes = uniqueStrings(body.source_types).filter(
    (s): s is SourceType => (SOURCE_TYPES as readonly string[]).includes(s)
  );

  const db = supabaseAdmin();

  // Narrow the finer-grained scope ids to this org only.
  const [dataSourceIds, collectionIds] = await Promise.all([
    filterOrgIds(db, "data_sources", admin.orgId, body.data_source_ids),
    filterOrgIds(db, "collections", admin.orgId, body.collection_ids),
  ]);

  // Optional expiry.
  let expiresAt: string | null = null;
  if (body.expires_at) {
    const d = new Date(body.expires_at as string);
    if (Number.isNaN(d.getTime())) {
      return Response.json({ error: "Invalid expiry date" }, { status: 400 });
    }
    expiresAt = d.toISOString();
  }

  const rawLimit = Number(body.rate_limit_per_min);
  const rateLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 60;

  // Generate the secret. Only the prefix + hash are persisted; `secret` is
  // returned once below and then unrecoverable.
  const { secret, prefix, hash } = generateApiKey("live");

  const { data, error } = await db
    .from("api_keys")
    .insert({
      org_id: admin.orgId,
      name,
      key_prefix: prefix,
      key_hash: hash,
      capabilities,
      source_types: sourceTypes,
      data_source_ids: dataSourceIds,
      collection_ids: collectionIds,
      rate_limit_per_min: rateLimit,
      expires_at: expiresAt,
      created_by: admin.memberId,
    })
    .select(KEY_COLUMNS)
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  // The ONLY response that carries the plaintext secret.
  return Response.json({ key: data, secret }, { status: 201 });
}

// DELETE — revoke a key (sets revoked_at). Idempotent-ish: a second revoke 404s.
//
//   ?id=<uuid>                  one key (the original contract, unchanged).
//   JSON body { ids: uuid[] }   up to 200 keys in ONE set-based update. Keys not in
//                               this org, or already revoked, come back in `failed`;
//                               the rest in `revoked`.
export async function DELETE(req: Request) {
  let admin;
  try {
    admin = await requireAdmin("api_keys:revoke");
  } catch (e) {
    return guard(e);
  }

  const db = supabaseAdmin();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    // No ?id=: the bulk form, when the body carries `ids`.
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // No body, or not JSON: the "id required" error below.
    }
    if (!body || body.ids === undefined) {
      return Response.json({ error: "A key id is required" }, { status: 400 });
    }
    return revokeMany(db, admin.orgId, body.ids);
  }

  const { data, error } = await db
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("org_id", admin.orgId) // tenant scope
    .is("revoked_at", null) // don't re-revoke
    .select("id")
    .maybeSingle();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return Response.json(
      { error: "Key not found or already revoked" },
      { status: 404 }
    );
  }

  return Response.json({ id: data.id, revoked: true });
}

/** Bulk revoke: one UPDATE … WHERE id IN (…) AND org_id = <session org> AND revoked_at IS NULL. */
async function revokeMany(db: Db, orgId: string, rawIds: unknown): Promise<Response> {
  const parsed = parseIds(rawIds, "ids", BULK_MAX_IDS);
  if ("error" in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  const { ids } = parsed;

  const revokedAt = new Date().toISOString();
  const { data, error } = await db
    .from("api_keys")
    .update({ revoked_at: revokedAt })
    .in("id", ids)
    .eq("org_id", orgId) // tenant scope
    .is("revoked_at", null) // don't re-revoke
    .select("id");

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  // Postgres returns lower-case uuids: report back in the caller's spelling.
  const done = new Set(((data ?? []) as { id: string }[]).map((r) => r.id.toLowerCase()));
  const revoked = ids.filter((k) => done.has(k.toLowerCase()));
  const failed = ids
    .filter((k) => !done.has(k.toLowerCase()))
    .map((k) => ({ id: k, error: "Key not found or already revoked" }));

  return Response.json({ revoked, failed, revoked_at: revokedAt });
}
