# PractiScale AI Brain Developer Pack v1

## Give this entire ZIP to the development team

This package has two clearly different parts.

### 01_RAG_KNOWLEDGE
These are the documents the AI may retrieve when answering questions or generating content.

They are split into four retrieval scopes:

1. `company_truth` - what PractiScale is, what it sells, audiences, sales philosophy, sales process, and delivery.
2. `company_brand` - how PractiScale as a company should communicate.
3. `founder_brand` - how Afra's founder/personal brand should communicate.
4. `approved_examples` - examples of previously approved content. These teach patterns and style. They are not authoritative company facts.

### 02_DEVELOPER_RULES
These files are implementation specifications.

Do NOT treat them as ordinary business knowledge. Use them to configure ingestion, metadata, retrieval, provenance, permissions, and the future sales-call intelligence pipeline.

## Important exclusions

- Duplicate company-overview and offer files from the earlier generated pack are intentionally excluded.
- `18_STYLE_OVERRIDE_FOR_CLAUDE.md` is intentionally excluded because the AI Brain should be model-neutral.
- No final sales-call taxonomy is included. The taxonomy must be developed from real PractiScale calls and versioned.
- Raw sales calls are not included in this ZIP. They belong in the live data pipeline, not the static Markdown knowledge base.

## First implementation goal

Before ingesting sales calls, verify that the AI can:

1. answer basic questions about PractiScale,
2. retrieve the correct current offer and pricing,
3. keep company voice separate from founder voice,
4. use approved examples as style references without treating them as facts,
5. cite or expose the source document used,
6. respect retrieval scopes and permissions.

Only then add the sales-call intelligence pipeline.
