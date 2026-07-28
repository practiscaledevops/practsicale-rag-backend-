# 7. Cost and Scaling

## Model prices (mid 2026, per 1M tokens, input / output)
- Claude Sonnet 4.6: 3 / 15 dollars (everyday default)
- Claude Haiku 4.5: 1 / 5 dollars (fast, cheap)
- Claude Opus 4.8: 5 / 25 dollars (hardest tasks)
- OpenAI GPT-4o mini: 0.15 / 0.60 dollars (cheapest worker)
- Embeddings text-embedding-3-large: 0.13 dollars, small: 0.02 dollars

Confirm current prices before contracting.

## Four cost levers (stack them, 55 to 70 percent savings)
1. Prompt caching (stable content first): 75 to 90 percent off repeated input.
2. Batch API for non-realtime jobs: about 50 percent off.
3. Model routing: cheap model for easy queries, flagship only when needed.
4. Semantic caching: serve stored answers to repeated questions.

## Rules of thumb
- One conversation: about 1 to 4 cents optimised.
- One hundred 2-minute scripts on Sonnet via batch: about 2 to 3 dollars.
- Stay on Supabase pgvector until 5 to 10 million chunks, then consider a dedicated vector database.

## Monthly estimates
- 1,000 users: roughly 130 to 200 dollars
- 10,000 users: roughly 1,000 to 1,500 dollars
- 100,000 users: roughly 12,000 dollars optimised
