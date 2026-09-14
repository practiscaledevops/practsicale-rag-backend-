// Per-answer query logging (migration 0014). Server-only, best-effort: never
// throws, never blocks the response, and silently skips if the table isn't there
// yet. Powers the knowledge-gap analytics (most-used sources, top unanswered
// questions). Query text is capped; it's the org's OWN employees' questions,
// stored for the org's own analytics.

import { supabaseAdmin } from "@/lib/supabase";

const MAX_QUERY_CHARS = 2000;
const MAX_DOC_IDS = 20;

export interface QueryLogInput {
  orgId: string;
  apiKeyId?: string | null;
  query: string;
  mode?: string | null;
  sourceTypes?: string[] | null;
  retrievedDocIds?: string[];
  grounded?: boolean | null;
  confidence?: number | null;
  refused?: boolean;
}

export async function logQuery(input: QueryLogInput): Promise<void> {
  const query = (input.query || "").trim();
  if (!input.orgId || !query) return;

  const docIds = [...new Set(input.retrievedDocIds ?? [])].filter(Boolean).slice(0, MAX_DOC_IDS);

  try {
    await supabaseAdmin()
      .from("query_log")
      .insert({
        org_id: input.orgId,
        api_key_id: input.apiKeyId ?? null,
        query: query.slice(0, MAX_QUERY_CHARS),
        mode: input.mode ?? null,
        source_types: input.sourceTypes ?? null,
        retrieved_doc_ids: docIds,
        top_document_id: docIds[0] ?? null,
        grounded: input.grounded ?? null,
        confidence: typeof input.confidence === "number" ? input.confidence : null,
        refused: input.refused ?? false,
      })
      .then(
        ({ error }) => {
          if (error && !/query_log/i.test(error.message)) {
            console.error("[query-log] insert failed:", error.message);
          }
        },
        (e) => console.error("[query-log] error:", e)
      );
  } catch {
    /* best-effort */
  }
}
