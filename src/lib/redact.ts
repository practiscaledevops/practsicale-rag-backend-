// PII redaction on ingest.
//
// The data contains personal information, so we strip obvious direct identifiers
// before text is embedded or stored. This is a FIRST PASS (regex-based) — it
// catches the common, high-risk patterns. For stronger coverage, add a
// dedicated PII detector (e.g. Presidio / an NER model) behind this same call.
//
// We intentionally KEEP the text readable (placeholders, not deletion) so the
// model can still reason about structure ("the customer", "a phone number").

const PATTERNS: { label: string; re: RegExp }[] = [
  { label: "[EMAIL]", re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi },
  // International & local phone numbers (7+ digits, optional +, spaces, dashes, parens).
  { label: "[PHONE]", re: /(?:(?:\+|00)\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,5}\d{2,4}/g },
  // Credit-card-like 13-16 digit runs (with optional spaces/dashes).
  { label: "[CARD]", re: /\b(?:\d[ -]?){13,16}\b/g },
  // Generic long national-ID / CNIC / SSN-like digit groups.
  { label: "[ID]", re: /\b\d{5}[- ]?\d{7}[- ]?\d\b/g },
  { label: "[SSN]", re: /\b\d{3}-\d{2}-\d{4}\b/g },
];

/** Replace direct PII identifiers with typed placeholders. */
export function redactPII(text: string): string {
  let out = text;
  // Order matters: redact the most specific (card/id) before the greedy phone rule.
  for (const { label, re } of [...PATTERNS].sort((a, b) => rank(a.label) - rank(b.label))) {
    out = out.replace(re, label);
  }
  return out;
}

function rank(label: string): number {
  const order = ["[EMAIL]", "[CARD]", "[SSN]", "[ID]", "[PHONE]"];
  const i = order.indexOf(label);
  return i === -1 ? 99 : i;
}
