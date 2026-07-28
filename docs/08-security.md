# 8. Security and Trust

## Prompt injection (the top threat)
Uploaded PDFs can hide instructions. Defend by:
- Treating all retrieved and uploaded content as data, never instructions.
- Keeping system instructions structurally separate from content.
- Scanning documents for malicious content at ingestion.
- Validating every model output (schema, policy checks, PII scan) before it leaves.

## Grounding and hallucination
- Answer only from provided context; say "I don't know" when unsupported.
- Enforce citations and score faithfulness against retrieved context.
- Keep a human in the loop for high-consequence output.

## Data protection
- Mask PII at ingestion, in retrieved context, and in outputs.
- Row Level Security isolates each org.
- Rate limit per user and per org.

## Compliance
- Sign data processing agreements with each provider.
- Pin data region where required; use no-retention options for the EU.
- Note the healthcare BAA versus no-retention trade off.
