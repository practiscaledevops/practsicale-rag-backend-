// Per-chunk retrieval logging (migration 0015). Server-only, best-effort: never
// throws, never blocks the response, and silently skips if the table isn't there
// yet. One row per chunk placed in an answer's context, with its rerank score and
// whether the answer cited it — powers the inspector's retrieval stats.

import { supabaseAdmin } from "@/lib/supabase";

export interface ChunkRetrievalEntry {
  chunkId: string;
  documentId?: string | null;
  score?: number | null;
  cited?: boolean;
}

const MAX = 50;

export async function logChunkRetrievals(orgId: string, entries: ChunkRetrievalEntry[]): Promise<void> {
  if (!orgId || entries.length === 0) return;
  const rows = entries.slice(0, MAX).map((e) => ({
    org_id: orgId,
    chunk_id: e.chunkId,
    document_id: e.documentId ?? null,
    score: typeof e.score === "number" ? e.score : null,
    cited: e.cited ?? false,
  }));
  try {
    await supabaseAdmin()
      .from("chunk_retrievals")
      .insert(rows)
      .then(
        ({ error }) => {
          if (error && !/chunk_retrievals/i.test(error.message)) {
            console.error("[chunk-retrieval] insert failed:", error.message);
          }
        },
        (e) => console.error("[chunk-retrieval] error:", e)
      );
  } catch {
    /* best-effort */
  }
}
