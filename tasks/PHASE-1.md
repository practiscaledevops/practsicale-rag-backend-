# Phase 1 — Prove the Retrieval Loop

Goal: ingest real Practiscale data and get grounded answers from an API, before any UI.

## Steps
1. **Set up Supabase.** Create a project. Apply `supabase/migrations/` in order. Confirm the `vector` extension, the tables, the HNSW and GIN indexes, and the `hybrid_search` function exist.
2. **Environment.** Fill `.env.local` from `.env.example` (Supabase URL and keys, OpenAI, Anthropic).
3. **Embeddings.** Confirm `src/lib/embeddings.ts` returns a 1024-length vector for a test string.
4. **Ingestion.** Run `npm run ingest -- ./sample.md`. Confirm rows appear in `documents` and `chunks`, and that `embedding` and `fts` are populated.
5. **Chunking by type.** Implement transcript speaker-turn chunking in `src/lib/chunking.ts` (currently a TODO). Keep call scores as one serialized chunk each.
6. **Retrieval.** Call `hybridSearch` directly and inspect results. Verify vector-only and keyword-only queries both return sensible hits.
7. **Reranking.** Add a Cohere key and confirm `rerank` improves ordering. Without a key it must still work.
8. **Chat endpoint.** POST to `/api/chat` and confirm a grounded, cited, streamed answer. Confirm it says "I don't know" when the answer is not in the data.
9. **Evaluation set.** Write 15 to 25 real questions with expected answers. Measure whether retrieval returns the right chunks (context recall) and whether answers stay grounded (faithfulness).

## Definition of done
- Ingesting a file populates chunks with embeddings and full text.
- `/api/chat` returns grounded, cited answers over that data and refuses when unsupported.
- The evaluation set passes at an agreed threshold.

## Notes for Claude Code
- Keep `org_id` on every query. Do not cross tenants.
- Do not put uploaded content into the system-instruction position; it goes in the context block only.
