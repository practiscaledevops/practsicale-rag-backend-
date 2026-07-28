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
}): Promise<RetrievedChunk[]> {
  const db = supabaseAdmin();
  const query_embedding = await embed(opts.query);
  const { data, error } = await db.rpc("hybrid_search_scoped", {
    p_org_id: opts.orgId,
    query_text: opts.query,
    query_embedding,
    p_source_types: opts.scope.sourceTypes,
    p_data_source_ids: opts.scope.dataSourceIds,
    p_collection_ids: opts.scope.collectionIds,
    match_count: opts.matchCount ?? 40,
  });
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
  const { data } = await db.from("chunks").select("*").in("id", parentIds);
  const parents = (data ?? []) as RetrievedChunk[];
  const byId = new Map(parents.map((p) => [p.id, p]));
  return chunks.map((c) => (c.parent_id && byId.get(c.parent_id)) || c);
}
