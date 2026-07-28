# 10. Getting Started

## 1. Prerequisites
- Node 20 or newer
- A Supabase project (note the URL, anon key, service role key)
- OpenAI and Anthropic API keys
- Optional: Supabase CLI + Docker for local development, Cohere, Upstash

## 2. Install
```bash
npm install
cp .env.example .env.local
```
Fill `.env.local` with your keys.

## 3. Database
Apply the migrations in order. Either:
```bash
supabase db push
```
or open the Supabase SQL editor and paste each file in `supabase/migrations/` in numeric order.

This enables the `vector` extension, creates the tables, the HNSW and GIN indexes, the `hybrid_search` function, and the Row Level Security policies.

## 4. Run
```bash
npm run dev
```

## 5. Ingest and test
```bash
npm run ingest -- ./sample.md
```
Then POST a question to `/api/chat` (see `docs/06-api-reference.md`).

## 6. Build with Claude Code
Open the folder in Claude Code and ask it to follow `tasks/PHASE-1.md`.
