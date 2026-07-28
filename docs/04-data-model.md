# 4. Data Model

All tables carry `org_id` for multi-tenancy and are protected by Row Level Security. See the migrations in `supabase/migrations/`.

## documents
The source of truth for each ingested item.
- `id`, `org_id`
- `source_type` (transcript, call_score, coaching, document)
- `title`, `uri` (storage path or source url)
- `content_hash` (for change detection)
- `metadata` jsonb (consultant, product, date, call_id, ...)
- `created_at`, `updated_at`

## chunks
Retrievable pieces. Child chunks are searched; parents give context.
- `id`, `org_id`, `document_id`, `parent_id`
- `content` (the text)
- `token_count`
- `metadata` jsonb
- `embedding` vector(1024)
- `fts` tsvector (generated from content)
- `model`, `embedding_version`
- `created_at`

Indexes: HNSW on `embedding`, GIN on `fts`, btree on `org_id`, `document_id`, `source_type`.

## conversations and messages
Chat history per user and org.

## api_keys
Hashed keys per org for external apps, with usage metering.

## prompts
Editable system prompts and templates, versioned, keyed by use case. Lets the dashboard change behaviour without a redeploy.
