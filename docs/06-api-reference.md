# 6. API Reference

All endpoints require an API key header once auth is wired: `Authorization: Bearer <key>`.

## POST /api/chat
Streaming chat over the knowledge base.
```json
{ "messages": [{ "role": "user", "content": "Why did closing rates drop?" }],
  "orgId": "org_123" }
```
Returns a streamed text response (Vercel AI SDK data stream).

## POST /api/ingest
Ingest a document.
```json
{ "orgId": "org_123", "sourceType": "transcript",
  "title": "Call 4821", "text": "...", "metadata": { "consultant": "A. Rai" } }
```
Returns `{ "documentId": "...", "chunks": 12 }`.

## POST /api/generate
Generate content from the knowledge base.
```json
{ "orgId": "org_123", "template": "video_script",
  "brief": "2 minute script on objection handling", "durationSeconds": 120 }
```
Returns the generated content (streamed). Bulk jobs should be queued instead.
