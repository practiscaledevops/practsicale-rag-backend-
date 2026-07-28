# 5. RAG Pipeline

## Ingestion

1. **Read** the file, extract clean text.
2. **Chunk** by type:
   - Transcripts: semantic or speaker-turn chunks, 20 to 50 percent overlap.
   - Structured records (call scores): one record equals one chunk, serialized to a sentence, raw fields kept as metadata.
   - PDFs and markdown: structure-aware split on headings.
   - Baseline: recursive split at 400 to 512 tokens, 10 to 20 percent overlap.
   - Keep a `parent_id` so small child chunks map to a larger parent section.
3. **Embed** each chunk with text-embedding-3-large at 1024 dims.
4. **Store** into `chunks` with the vector, the tsvector, and metadata.

Detect changes by content hash. Re-embed only changed chunks.

## Retrieval (runtime)

1. **Route:** the model picks the source(s) via tool calling and fills filters (date, consultant, product).
2. **Hybrid search:** vector similarity and full-text search run together; results fused with Reciprocal Rank Fusion. See `hybrid_search` in the migrations.
3. **Rerank:** a cross-encoder reorders the top ~50, keep top 6 to 8.
4. **Expand:** fetch parent chunks for context.
5. **Generate:** assemble the prompt and stream the answer.

## Grounding

The system prompt requires the model to answer only from provided context, cite chunk ids, and say "I don't know" when unsupported. A faithfulness check scores answers against the retrieved context.
