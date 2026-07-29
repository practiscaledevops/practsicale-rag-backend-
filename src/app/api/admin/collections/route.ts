// GET  /api/admin/collections — list this org's collections + document counts.
// POST /api/admin/collections — create a collection (name, description).
//
// Collections are named groupings of documents used as the finest-grained scope
// for a scoped API key (a key can be limited to specific collection ids).
//
// org_id is resolved SERVER-SIDE from the admin session (never from the request
// body) and every query is filtered by it, so a request can only ever read or
// create collections within the caller's own tenant. Names are slugified and the
// DB enforces a unique (org_id, slug) key.

import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin, AdminAuthError } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

// Embedded aggregate: PostgREST returns document_collections as [{ count: n }]
// for each collection (FK document_collections.collection_id -> collections.id).
const SELECT = "id, name, slug, description, created_at, document_collections(count)";

interface CollectionRow {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  created_at: string;
  document_collections: { count: number }[] | null;
}

function guard(e: unknown): Response {
  const err = e as AdminAuthError;
  return Response.json({ error: err.message }, { status: err.status ?? 401 });
}

/** URL-safe slug from a display name (used for the unique (org_id, slug) key). */
function slugify(name: string): string | null {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || null;
}

export async function GET() {
  let admin;
  try {
    admin = await requireAdmin("collections:read");
  } catch (e) {
    return guard(e);
  }

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("collections")
    .select(SELECT)
    .eq("org_id", admin.orgId)
    .order("created_at", { ascending: false });

  if (error) return Response.json({ error: error.message }, { status: 500 });

  const collections = ((data ?? []) as CollectionRow[]).map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    created_at: c.created_at,
    document_count: c.document_collections?.[0]?.count ?? 0,
  }));

  return Response.json({ collections });
}

export async function POST(req: Request) {
  let admin;
  try {
    admin = await requireAdmin("collections:write");
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
  const description =
    typeof body.description === "string" && body.description.trim() !== ""
      ? body.description.trim()
      : null;

  if (!name) return Response.json({ error: "A collection name is required" }, { status: 400 });

  const slug = slugify(name);
  if (!slug) {
    return Response.json(
      { error: "Name must contain at least one letter or number" },
      { status: 400 }
    );
  }

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("collections")
    .insert({
      org_id: admin.orgId, // tenant is the session's org — never client input
      name,
      slug,
      description,
      created_by: admin.memberId,
    })
    .select("id, name, slug, description, created_at")
    .single();

  if (error) {
    // Unique (org_id, slug) violation -> a collection with this name exists.
    if ((error as { code?: string }).code === "23505") {
      return Response.json(
        { error: `A collection named "${name}" already exists.` },
        { status: 409 }
      );
    }
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ collection: { ...data, document_count: 0 } }, { status: 201 });
}
