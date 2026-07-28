// Decide which data source(s) to search for a given query.
// Start with simple keyword rules; upgrade to LLM tool calling later.

export type SourceType = "transcript" | "call_score" | "coaching" | "document" | null;

export function routeQuery(query: string): SourceType {
  const q = query.toLowerCase();
  if (q.includes("score") || q.includes("rating")) return "call_score";
  if (q.includes("coach") || q.includes("recommend")) return "coaching";
  if (q.includes("transcript") || q.includes("said") || q.includes("call")) return "transcript";
  // null means search across all sources
  return null;
}

// TODO (Phase 2+): replace with model tool calling so the LLM picks sources
// and fills filters (date range, consultant, product) itself.
