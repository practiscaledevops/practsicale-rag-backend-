// Scope enforcement for a resolved API key.
//
// Two layers, both required (defense in depth):
//   1. requireCapability() — checked BEFORE the handler runs.
//   2. scopeFilters()      — passed into retrieval so the DB only ever returns
//                            rows the key is allowed to see.

import { AuthError, type ApiKeyRecord, type Capability } from "./context";

/** Throw 403 unless the key grants the capability. */
export function requireCapability(key: ApiKeyRecord, cap: Capability): void {
  if (!key.capabilities?.includes(cap)) {
    throw new AuthError(`This key is not permitted to '${cap}'`, 403);
  }
}

export interface ScopeFilters {
  sourceTypes: string[];
  dataSourceIds: string[];
  collectionIds: string[];
}

/**
 * The retrieval filters implied by a key's scope. An empty array on any
 * dimension means "no restriction on that dimension" — matching the SQL
 * function hybrid_search_scoped.
 */
export function scopeFilters(key: ApiKeyRecord): ScopeFilters {
  return {
    sourceTypes: key.source_types ?? [],
    dataSourceIds: key.data_source_ids ?? [],
    collectionIds: key.collection_ids ?? [],
  };
}

/**
 * Narrow a caller-requested source_type against the key's allowed set.
 * If the caller asks for a type the key can't see, that's a 403 — not a silent
 * empty result, so misconfigured integrations are obvious.
 */
export function intersectSourceType(key: ApiKeyRecord, requested?: string | null): string[] {
  const allowed = key.source_types ?? [];
  if (!requested) return allowed; // no narrowing; use the full allowed set
  if (allowed.length > 0 && !allowed.includes(requested)) {
    throw new AuthError(`This key cannot access source_type '${requested}'`, 403);
  }
  return [requested];
}
