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

  const { data, error } = await db.rpc("hybrid_search_scoped", params);
  if (error) throw error;
  return (data ?? []) as RetrievedChunk[];
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
