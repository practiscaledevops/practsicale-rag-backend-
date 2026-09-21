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

// Sentinels that match no row, used when a narrowing intersection is empty —
// because an EMPTY filter array means "no restriction" (all) in the SQL, so we
// must never collapse "nothing allowed" to []. source_types is text[] so any
// impossible name works; collection_ids is uuid[] in the search functions, so
// its sentinel must still be a valid uuid (the nil uuid) or Postgres raises a
// cast error and the whole retrieval fails instead of returning nothing.
const MATCH_NOTHING = "__none__";
export const NO_COLLECTION = "00000000-0000-0000-0000-000000000000";

/**
 * Narrow one scope dimension (source_types or collection_ids) by a caller-
 * requested allow-list. NARROWING ONLY — the result is always a subset of what
 * the key permits, so a trusted caller (e.g. a spoke applying role-based access)
 * can restrict but never widen. Rules, given the key set (empty = all) and the
 * request (undefined/empty = "not specified"):
 *   - request not specified          -> the key's set unchanged
 *   - key unrestricted (all)         -> the requested set
 *   - both restricted                -> their intersection, or [MATCH_NOTHING]
 *                                       if the intersection is empty (never []).
 */
function narrowDim(keyAllowed: string[], requested?: string[] | null, sentinel: string = MATCH_NOTHING): string[] {
  if (requested == null) return keyAllowed;
  const req = requested.filter((s) => typeof s === "string" && s.length > 0);
  if (req.length === 0) return keyAllowed;
  if (keyAllowed.length === 0) return req;
  const inter = keyAllowed.filter((s) => req.includes(s));
  return inter.length > 0 ? inter : [sentinel];
}

/**
 * The key's scope narrowed by a caller-requested allow-list (source_types /
 * collection_ids). Used to apply role-based knowledge partitioning from a trusted
 * spoke: the spoke resolves the user's role and passes the allowed sets; this can
 * only ever restrict below the key's grant, never widen it.
 */
export function narrowScope(
  key: ApiKeyRecord,
  requested?: { sourceTypes?: string[] | null; collectionIds?: string[] | null } | null
): ScopeFilters {
  const base = scopeFilters(key);
  if (!requested) return base;
  return {
    sourceTypes: narrowDim(base.sourceTypes, requested.sourceTypes),
    dataSourceIds: base.dataSourceIds,
    collectionIds: narrowDim(base.collectionIds, requested.collectionIds, NO_COLLECTION),
  };
}
