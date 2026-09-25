// /api/admin/knowledge/entities — the entity directory (WHO and WHAT exist
// inside the knowledge).
//   GET    ?kind=&q=&limit=  → { entities, counts }
//          ?id=<entityId>    → { entity, mentions: [{role, value, object, document_id}] }
//   POST   { action: "merge", ids: uuid[] (1..50), targetId: uuid } — fold the
//          `ids` entities into `targetId`: their mentions and metrics move to the
//          target, their names + aliases become the target's aliases, mention
//          counts add up, exact duplicate mentions are dropped, then they are
//          deleted — all in one transaction (public.merge_entities, migration
//          0019; step by step until that is applied).
//          → { ok, entity, merged: ids, failed: [{ id, error, status }], mentionsMoved }
//   DELETE { ids: uuid[] (1..200) } — delete entities (their mentions cascade;
//          metrics keep their rows, unlinked). → { ok, deleted: ids, failed }
// Every statement is scoped to the admin's org.

import { supabaseAdmin } from "@/lib/supabase";
import { isDemo } from "@/lib/demo/mode";
import { logDecision } from "@/lib/knowledge-store";
import { guard, dbError, objectStubs, str, uuid } from "../_shared";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 60;

export async function GET(req: Request) {
  const g = await guard();
  if ("response" in g) return g.response;
  const { admin } = g;
  const url = new URL(req.url);
  const id = str(url.searchParams.get("id"), 64);
  const kind = str(url.searchParams.get("kind"), 40);
  const q = str(url.searchParams.get("q"), 80).replace(/[%,()]/g, " ");
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 300)));
  const db = supabaseAdmin();
  try {
    if (id) {
      const { data: entity } = await db.from("entities").select("*").eq("org_id", admin.orgId).eq("id", id).maybeSingle();
      if (!entity) return Response.json({ error: "Not found" }, { status: 404 });
      const { data: mentions } = await db.from("entity_mentions").select("id, role, value, object_id, document_id, created_at").eq("org_id", admin.orgId).eq("entity_id", id).order("created_at", { ascending: false }).limit(200);
      const rows = (mentions ?? []) as { object_id: string | null }[];
      const stubs = await objectStubs(admin.orgId, rows.map((m) => m.object_id).filter((x): x is string => !!x));
      return Response.json({ entity, mentions: (mentions ?? []).map((m: { object_id: string | null }) => ({ ...m, object: m.object_id ? stubs[m.object_id] ?? null : null })) });
    }
    let query = db.from("entities").select("*").eq("org_id", admin.orgId);
    if (kind) query = query.eq("kind", kind);
    if (q) query = query.or(`name.ilike.%${q}%,slug.ilike.%${q}%`);
    const { data, error } = await query.order("mention_count", { ascending: false }).limit(limit);
    if (error) throw error;
    const counts: Record<string, number> = {};
    for (const e of (data ?? []) as { kind: string }[]) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    return Response.json({ entities: data ?? [], counts });
  } catch (e) {
    return dbError(e);
  }
}

/** Most entities one merge folds in (the client batches larger selections). */
const MERGE_MAX_IDS = 50;
/** Most entities one DELETE removes. */
const DELETE_MAX_IDS = 200;
/** Most aliases kept on a merged entity. */
const MAX_ALIASES = 60;
/** Mentions scanned for exact duplicates after a merge. */
const DEDUPE_SCAN = 5000;
/** `in (…)` filters travel in the URL: keep each statement's id list short. */
const ID_BATCH = 200;

interface EntityRow {
  id: string;
  kind: string;
  name: string;
  slug: string;
  aliases: string[] | null;
  attributes: Record<string, unknown> | null;
  mention_count: number | null;
}

type Failure = { id: string; error: string; status?: number };

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const body = (await req.json().catch(() => null)) as unknown;
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/** A non-empty array of at most `max` uuids (deduped), or a 400 message. */
function idList(v: unknown, max: number): { ids: string[] } | { error: string } {
  if (!Array.isArray(v) || v.length === 0) return { error: "ids must be a non-empty array of ids" };
  if (v.length > max) return { error: `At most ${max} ids per request` };
  const ids = v.map((x) => uuid(x));
  if (ids.some((id) => !id)) return { error: "ids must be uuids" };
  return { ids: Array.from(new Set(ids)) };
}

function batches<T>(items: T[], size = ID_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Target aliases + every merged name and alias, case-insensitively unique, never the target's own name. */
function mergedAliases(target: EntityRow, sources: EntityRow[]): string[] {
  const seen = new Map<string, string>();
  const add = (s: unknown) => {
    const v = typeof s === "string" ? s.trim() : "";
    const k = v.toLowerCase();
    if (v && k !== target.name.trim().toLowerCase() && !seen.has(k)) seen.set(k, v);
  };
  for (const a of target.aliases ?? []) add(a);
  for (const s of sources) {
    add(s.name);
    for (const a of s.aliases ?? []) add(a);
  }
  return Array.from(seen.values()).slice(0, MAX_ALIASES);
}

type Db = ReturnType<typeof supabaseAdmin>;

interface MergeOutcome {
  merged: string[];
  mentionsMoved: number;
  updated: EntityRow | null;
}

/** PostgREST / Postgres: the function does not exist (migration 0019 not applied yet). */
function isMissingFunction(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return err.code === "PGRST202" || err.code === "42883" || /could not find the function/i.test(err.message ?? "");
}

/**
 * The whole merge in one transaction (public.merge_entities). Returns null when
 * that function is not available (demo mode, or migration 0019 not applied), so
 * the caller can fall back; any other error is thrown with nothing applied.
 */
async function mergeInOneTransaction(
  db: Db,
  orgId: string,
  targetId: string,
  ids: string[],
  aliases: string[],
  attributes: Record<string, unknown>
): Promise<MergeOutcome | null> {
  if (isDemo()) return null;
  const { data, error } = await db.rpc("merge_entities", {
    p_org: orgId,
    p_target: targetId,
    p_ids: ids,
    p_aliases: aliases,
    p_attributes: attributes,
  });
  if (error) {
    if (isMissingFunction(error)) return null;
    throw error;
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { merged?: string[] | null; mentions_moved?: number | null; entity?: EntityRow | null }
    | null
    | undefined;
  if (!row) throw new Error("The merge returned no result");
  return { merged: row.merged ?? [], mentionsMoved: row.mentions_moved ?? 0, updated: row.entity ?? null };
}

/** The merge as separate statements: only for databases without migration 0019. */
async function mergeStepwise(
  db: Db,
  orgId: string,
  target: EntityRow,
  sources: EntityRow[],
  found: string[],
  aliases: string[],
  attributes: Record<string, unknown>
): Promise<MergeOutcome> {
  const targetId = target.id;
  // 1. Mentions → target. entity_mentions has no unique index, so nothing can collide.
  const { data: moved, error: moveError } = await db
    .from("entity_mentions")
    .update({ entity_id: targetId })
    .eq("org_id", orgId)
    .in("entity_id", found)
    .select("id");
  if (moveError) throw moveError;
  const mentionsMoved = (moved ?? []).length;

  // 2. Metrics linked to a merged entity follow it (best-effort: the table is optional here).
  await db.from("metrics").update({ entity_id: targetId }).eq("org_id", orgId).in("entity_id", found).then(() => {}, () => {});

  // 3. Drop exact duplicate mentions (same object/document, role and value) now on the target.
  if (mentionsMoved > 0) {
    const { data: all } = await db
      .from("entity_mentions")
      .select("id, object_id, document_id, role, value")
      .eq("org_id", orgId)
      .eq("entity_id", targetId)
      .order("created_at", { ascending: true })
      .limit(DEDUPE_SCAN);
    const keep = new Set<string>();
    const dupes: string[] = [];
    for (const m of (all ?? []) as { id: string; object_id: string | null; document_id: string | null; role: string | null; value: string | null }[]) {
      const key = [m.object_id ?? "", m.document_id ?? "", (m.role ?? "").toLowerCase(), (m.value ?? "").trim().toLowerCase()].join("\u0000");
      if (keep.has(key)) dupes.push(m.id);
      else keep.add(key);
    }
    for (const batch of batches(dupes)) {
      await db.from("entity_mentions").delete().eq("org_id", orgId).in("id", batch).then(() => {}, () => {});
    }
  }

  // 4. The target absorbs names, attributes and mention counts.
  const mentionCount = sources.reduce((n, s) => n + (s.mention_count ?? 0), target.mention_count ?? 0);
  const { data: updated, error: updateError } = await db
    .from("entities")
    .update({ aliases, attributes, mention_count: mentionCount })
    .eq("org_id", orgId)
    .eq("id", targetId)
    .select("*")
    .single();
  if (updateError) throw updateError;

  // 5. The merged entities go (nothing references them any more).
  const { data: removed, error: deleteError } = await db.from("entities").delete().eq("org_id", orgId).in("id", found).select("id");
  if (deleteError) throw deleteError;
  const merged = ((removed ?? []) as { id: string }[]).map((r) => r.id);
  return { merged, mentionsMoved, updated: (updated as EntityRow | null) ?? null };
}

export async function POST(req: Request) {
  const g = await guard("documents:write");
  if ("response" in g) return g.response;
  const { admin } = g;
  const body = await readJson(req);
  if (!body || body.action !== "merge") return Response.json({ error: "Unknown action (expected \"merge\")" }, { status: 400 });
  const targetId = uuid(body.targetId);
  if (!targetId) return Response.json({ error: "targetId must be an entity id" }, { status: 400 });
  const parsed = idList(body.ids, MERGE_MAX_IDS);
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
  const ids = parsed.ids.filter((id) => id !== targetId);
  if (ids.length === 0) return Response.json({ error: "Pick at least one entity to merge into the target" }, { status: 400 });

  const orgId = admin.orgId;
  const db = supabaseAdmin();
  try {
    const { data: targetData, error: targetError } = await db.from("entities").select("*").eq("org_id", orgId).eq("id", targetId).maybeSingle();
    if (targetError) throw targetError;
    const target = targetData as EntityRow | null;
    if (!target) return Response.json({ error: "Target entity not found" }, { status: 404 });

    const { data: sourceData, error: sourceError } = await db.from("entities").select("*").eq("org_id", orgId).in("id", ids);
    if (sourceError) throw sourceError;
    const sources = (sourceData ?? []) as EntityRow[];
    const found = sources.map((s) => s.id);
    const failed: Failure[] = ids.filter((id) => !found.includes(id)).map((id) => ({ id, error: "Not found", status: 404 }));
    if (found.length === 0) return Response.json({ ok: true, entity: target, merged: [], failed, mentionsMoved: 0 });

    const aliases = mergedAliases(target, sources);
    const attributes = Object.assign({}, ...sources.map((s) => s.attributes ?? {}), target.attributes ?? {}) as Record<string, unknown>;
    // Steps 1-5 in one transaction (migration 0019), so a failure or a retry
    // never applies half a merge; step by step only until it is applied.
    const outcome =
      (await mergeInOneTransaction(db, orgId, targetId, found, aliases, attributes)) ??
      (await mergeStepwise(db, orgId, target, sources, found, aliases, attributes));
    const { merged, mentionsMoved, updated } = outcome;
    for (const id of found) if (!merged.includes(id)) failed.push({ id, error: "Not found or already merged", status: 404 });

    await logDecision(db, orgId, {
      stage: "entities",
      decision: "entities_merged",
      input: { targetId, ids: merged },
      output: { by: admin.email, target: target.name, names: sources.map((s) => s.name), mentionsMoved },
    });
    return Response.json({ ok: true, entity: updated ?? target, merged, failed, mentionsMoved });
  } catch (e) {
    return dbError(e);
  }
}

export async function DELETE(req: Request) {
  const g = await guard("documents:write");
  if ("response" in g) return g.response;
  const { admin } = g;
  const body = await readJson(req);
  if (!body) return Response.json({ error: "Expected a JSON body { ids }" }, { status: 400 });
  const parsed = idList(body.ids, DELETE_MAX_IDS);
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
  const { ids } = parsed;
  const db = supabaseAdmin();
  try {
    const { data, error } = await db.from("entities").delete().eq("org_id", admin.orgId).in("id", ids).select("id, name");
    if (error) throw error;
    const rows = (data ?? []) as { id: string; name: string }[];
    const deleted = rows.map((r) => r.id);
    const failed: Failure[] = ids.filter((id) => !deleted.includes(id)).map((id) => ({ id, error: "Not found", status: 404 }));
    if (deleted.length) {
      await logDecision(db, admin.orgId, {
        stage: "entities",
        decision: "entities_deleted",
        input: { ids: deleted },
        output: { by: admin.email, names: rows.map((r) => r.name) },
      });
    }
    return Response.json({ ok: true, deleted, failed });
  } catch (e) {
    return dbError(e);
  }
}
