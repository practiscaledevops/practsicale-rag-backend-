import { supabaseAdmin } from "./supabase";
import { embed } from "./embeddings";
import type { ScopeFilters } from "./auth/scope";

export interface RetrievedChunk {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  document_id: string;
  parent_id: string | null;
  source_type?: string | null;
  /** Reranker relevance score in [0,1], when a reranker ran. Drives confidence. */
  score?: number;
}

// Scope-aware hybrid retrieval. This is the ONLY retrieval path the public API
// should use — it enforces the key's scope inside the SQL function, so the
// database never returns a chunk the key is not allowed to see.
export async function hybridSearchScoped(opts: {
  orgId: string;
  query: string;
  scope: ScopeFilters;
  matchCount?: number;
  /** Optional RRF tuning (from settings); the SQL function defaults them. */
  fullTextWeight?: number;
  semanticWeight?: number;
  rrfK?: number;
  /** Optional narrowing of source types (e.g. from the router), pre-intersected
   *  with the key's scope by the caller. Overrides scope.sourceTypes when given. */
  sourceTypes?: string[];
}): Promise<RetrievedChunk[]> {
  const db = supabaseAdmin();
  const query_embedding = await embed(opts.query);
  // When no embeddings provider is configured, embed() returns a zero vector.
  // In that case the semantic leg is pure noise (all distances equal), so we
  // turn it OFF (semantic_weight 0) and let the lexical leg decide — otherwise
  // arbitrary chunks outrank real keyword matches.
  const hasVector = query_embedding.some((v) => v !== 0);

  const params: Record<string, unknown> = {
    p_org_id: opts.orgId,
    // AND the terms (websearch default). Verbose questions are distilled to clean
    // keywords by the query-rewrite stage first, so ANDing stays precise —
    // e.g. "James Anderson" matches only his calls, not every consultant named James.
    query_text: opts.query,
    query_embedding,
    p_source_types: opts.sourceTypes ?? opts.scope.sourceTypes,
    p_data_source_ids: opts.scope.dataSourceIds,
    p_collection_ids: opts.scope.collectionIds,
    // Wider default candidate pool (60) gives the reranker more to choose from,
    // improving top-k quality. Callers may still pass an explicit matchCount.
    match_count: opts.matchCount ?? 60,
  };
  if (typeof opts.fullTextWeight === "number") params.full_text_weight = opts.fullTextWeight;
  if (!hasVector) params.semantic_weight = 0;
  else if (typeof opts.semanticWeight === "number") params.semantic_weight = opts.semanticWeight;
  if (typeof opts.rrfK === "number") params.rrf_k = opts.rrfK;

  // Pass 1: AND (websearch default) — precise. "James Anderson" matches only his
  // calls, not every consultant named James.
  let results = await runSearch(db, params);

  // Pass 2: if AND was too sparse, retry ORing the terms — recall. This rescues
  // queries where a legitimate term isn't in the target chunk (e.g. "Buildout
  // pricing" when the price chunk never says the word "pricing"). ts_rank_cd
  // still ranks chunks matching MORE terms higher, so the right chunk surfaces.
  if (results.length < 3) {
    const orText = toOrQuery(opts.query);
    if (orText && orText !== opts.query) {
      const orResults = await runSearch(db, { ...params, query_text: orText });
      if (orResults.length > results.length) results = orResults;
    }
  }
  return results;
}

async function runSearch(
  db: ReturnType<typeof supabaseAdmin>,
  params: Record<string, unknown>
): Promise<RetrievedChunk[]> {
  const { data, error } = await db.rpc("hybrid_search_scoped", params);
  if (error) throw error;
  return (data ?? []) as RetrievedChunk[];
}

/** Join a query's significant terms with the websearch OR operator. */
function toOrQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter((t) => t.length > 1 && t !== "or" && t !== "and")
    .slice(0, 32);
  return terms.length ? terms.join(" OR ") : query;
}

// ---- Lane-aware retrieval (Operating Intelligence) ---------------------------

/** A chunk returned by the lane search: carries its knowledge-object identity. */
export interface LaneChunk extends RetrievedChunk {
  object_id: string | null;
  intelligence_class: string;
  domain: string | null;
  /** Fused RRF score from the SQL function (relative within one search). */
  rrf_score: number;
}

/** Thrown when migration 0017 hasn't been applied yet (callers fall back). */
export const LANE_RPC_MISSING = "LANE_RPC_MISSING";

/**
 * Hybrid search restricted to intelligence lanes (classes), optional domains,
 * or specific objects — the DB-side half of "look in the right drawers first".
 * The key's scope is still enforced inside the SQL. Same AND→OR recall retry as
 * hybridSearchScoped. Throws LANE_RPC_MISSING if the RPC doesn't exist.
 */
export async function hybridSearchLane(opts: {
  orgId: string;
  query: string;
  scope: ScopeFilters;
  classes?: string[];
  domains?: string[];
  objectIds?: string[];
  sourceTypes?: string[];
  matchCount?: number;
  fullTextWeight?: number;
  semanticWeight?: number;
  rrfK?: number;
  /** Reuse an embedding computed once per query across lanes. */
  queryEmbedding?: number[];
}): Promise<LaneChunk[]> {
  const db = supabaseAdmin();
  const query_embedding = opts.queryEmbedding ?? (await embed(opts.query));
  const hasVector = query_embedding.some((v) => v !== 0);

  const params: Record<string, unknown> = {
    p_org_id: opts.orgId,
    query_text: opts.query,
    query_embedding,
    p_source_types: opts.sourceTypes ?? opts.scope.sourceTypes,
    p_data_source_ids: opts.scope.dataSourceIds,
    p_collection_ids: opts.scope.collectionIds,
    p_classes: opts.classes ?? [],
    p_domains: opts.domains ?? [],
    p_object_ids: opts.objectIds ?? [],
    match_count: opts.matchCount ?? 40,
  };
  if (typeof opts.fullTextWeight === "number") params.full_text_weight = opts.fullTextWeight;
  if (!hasVector) params.semantic_weight = 0;
  else if (typeof opts.semanticWeight === "number") params.semantic_weight = opts.semanticWeight;
  if (typeof opts.rrfK === "number") params.rrf_k = opts.rrfK;

  const run = async (p: Record<string, unknown>): Promise<LaneChunk[]> => {
    const { data, error } = await db.rpc("hybrid_search_lane", p);
    if (error) {
      const msg = String(error.message ?? "");
      if (error.code === "42883" || /hybrid_search_lane/i.test(msg) || /schema cache/i.test(msg)) {
        throw new Error(LANE_RPC_MISSING);
      }
      throw error;
    }
    return (data ?? []) as LaneChunk[];
  };

  let results = await run(params);
  if (results.length < 3) {
    const orText = toOrQuery(opts.query);
    if (orText && orText !== opts.query) {
      const orResults = await run({ ...params, query_text: orText });
      if (orResults.length > results.length) results = orResults;
    }
  }
  return results;
}

// Hybrid retrieval: vector + full text, fused by Reciprocal Rank Fusion in SQL.
// (Original single-source variant; prefer hybridSearchScoped for the API path.)
export async function hybridSearch(opts: {
  orgId: string;
  query: string;
  matchCount?: number;
  sourceType?: string | null;
}): Promise<RetrievedChunk[]> {
  const db = supabaseAdmin();
  const query_embedding = await embed(opts.query);
  const { data, error } = await db.rpc("hybrid_search", {
    p_org_id: opts.orgId,
    query_text: opts.query,
    query_embedding,
    match_count: opts.matchCount ?? 40,
    filter_source_type: opts.sourceType ?? null,
  });
  if (error) throw error;
  return (data ?? []) as RetrievedChunk[];
}

// Fetch parent chunks (larger context) for a set of child chunks.
export async function expandParents(chunks: RetrievedChunk[]): Promise<RetrievedChunk[]> {
  const parentIds = chunks.map((c) => c.parent_id).filter(Boolean) as string[];
  if (parentIds.length === 0) return chunks;
  const db = supabaseAdmin();
  // Select only the fields the pipeline uses — never `*`, which would pull each
  // parent's 1024-float embedding vector (heavy, and it must never leak client-
  // side). parent_id is derived from already org-scoped chunks, so these ids
  // never cross tenants.
  const { data } = await db
    .from("chunks")
    .select("id, content, metadata, document_id, parent_id, source_type")
    .in("id", parentIds);
  const parents = (data ?? []) as RetrievedChunk[];
  const byId = new Map(parents.map((p) => [p.id, p]));
  return chunks.map((c) => (c.parent_id && byId.get(c.parent_id)) || c);
}

// ---- Full-call transcript expansion ------------------------------------------

/** Approx token count for a chunk: the ingest-stamped count, else ~4 chars/token. */
function chunkTokens(c: RetrievedChunk): number {
  const md = c.metadata as Record<string, unknown> | null | undefined;
  return Number(md?.tokens) || Math.ceil((c.content?.length ?? 0) / 4);
}

/**
 * Pure core of expandTranscripts (no DB, exported for tests). Given the ranked
 * input `chunks` and the full created_at-ordered chunk set of each target call
 * (`chunksByDoc`), rebuild the list so each of the first `maxCalls` transcript
 * documents — in first-seen (rank) order — is replaced by its full call, kept in
 * reading order until its fair token share is spent (always at least the summary
 * + 1 body chunk). The full call takes the rank position of its best chunk; the
 * call's other original chunks are deduped away. Non-transcript chunks and calls
 * beyond `maxCalls` pass through untouched.
 */
export function assembleFullCalls(
  chunks: RetrievedChunk[],
  chunksByDoc: Map<string, RetrievedChunk[]>,
  maxCalls: number,
  maxTokens: number
): RetrievedChunk[] {
  // Distinct transcript document_ids in first-seen order; expand only the top few.
  const targets: string[] = [];
  for (const c of chunks) {
    if (c.source_type === "transcript" && !targets.includes(c.document_id)) targets.push(c.document_id);
  }
  const expandTargets = targets.slice(0, Math.max(0, maxCalls));
  if (expandTargets.length === 0) return chunks;

  // Fair per-call token share: three ~30k-token calls stay within the model's
  // input budget. Keep each call's chunks in order until the share is hit, but
  // never drop below the summary + first body chunk (a review needs both ends).
  const share = Math.floor(maxTokens / expandTargets.length);
  const fullCall = new Map<string, RetrievedChunk[]>();
  for (const docId of expandTargets) {
    const ordered = chunksByDoc.get(docId);
    if (!ordered || ordered.length === 0) continue; // nothing fetched → leave the originals
    const kept: RetrievedChunk[] = [];
    let used = 0;
    for (const c of ordered) {
      const t = chunkTokens(c);
      if (kept.length >= 2 && used + t > share) break;
      kept.push(c);
      used += t;
    }
    fullCall.set(docId, kept);
  }

  // Rebuild: pass every non-target chunk through; the FIRST time a target doc's
  // chunk appears, splice in its full ordered set and skip that doc's other
  // originals (deduped). Overall ordering is preserved.
  const spliced = new Set<string>();
  const out: RetrievedChunk[] = [];
  for (const c of chunks) {
    const full = c.source_type === "transcript" ? fullCall.get(c.document_id) : undefined;
    if (!full) {
      out.push(c);
      continue;
    }
    if (spliced.has(c.document_id)) continue;
    spliced.add(c.document_id);
    out.push(...full);
  }
  return out;
}

/**
 * Depth expansion for call reviews. Retrieval FINDS the right calls but usually
 * pulls only each call's best few chunks — often the summary (opening + closing)
 * — so the model can only see the ends of a call, not the middle. Reviewing a
 * whole call needs the FULL transcript. For the first `maxCalls` transcript
 * documents among `chunks` (in rank order), fetch every chunk of the call in one
 * query and splice the full, in-order transcript back in where its best chunk
 * ranked, within a per-call token budget so the calls together stay ~`maxTokens`.
 * Non-transcript inputs and calls beyond `maxCalls` are untouched. Migration- and
 * edge-safe: no transcript chunks, or a DB error, returns `chunks` unchanged.
 */
export async function expandTranscripts(
  orgId: string,
  chunks: RetrievedChunk[],
  opts?: { maxCalls?: number; maxTokens?: number }
): Promise<RetrievedChunk[]> {
  const maxCalls = opts?.maxCalls ?? 3;
  const maxTokens = opts?.maxTokens ?? 30_000;

  // Distinct transcript document_ids in first-seen (rank) order; expand the top few.
  const targets: string[] = [];
  for (const c of chunks) {
    if (c.source_type === "transcript" && !targets.includes(c.document_id)) targets.push(c.document_id);
  }
  const expandTargets = targets.slice(0, maxCalls);
  if (expandTargets.length === 0) return chunks;

  // One query for every chunk of the target calls, in reading order (created_at
  // ASC = summary first, then body chunks by timestamp). Select only the fields
  // the pipeline uses — never `*`, which would pull the 1024-float embeddings.
  // Re-filter by org_id: these document_ids already passed scoped retrieval, and
  // the explicit org filter keeps the fetch tenant-safe on its own.
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("chunks")
    .select("id, content, metadata, document_id, parent_id, source_type, created_at")
    .eq("org_id", orgId)
    .in("document_id", expandTargets)
    .order("created_at", { ascending: true });
  if (error || !data) {
    // Never throw: a failed depth expansion falls back to the top-K picks.
    console.error("[expandTranscripts] fetch failed:", error?.message ?? "no data");
    return chunks;
  }

  const chunksByDoc = new Map<string, RetrievedChunk[]>();
  for (const c of data as RetrievedChunk[]) {
    chunksByDoc.set(c.document_id, [...(chunksByDoc.get(c.document_id) ?? []), c]);
  }
  return assembleFullCalls(chunks, chunksByDoc, maxCalls, maxTokens);
}
