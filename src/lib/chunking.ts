// Chunking strategies by source type.
//
// Child chunks are what retrieval searches; a PARENT chunk holds the larger
// section a child came from, so retrieval can expand a hit back to full context
// (see src/lib/retrieval.ts -> expandParents).
//
// Because parents and children are separate rows and their real database ids do
// not exist until insert time, chunkDocument links them with a LOCAL key:
//   - a parent carries `key`      (its local id, e.g. "p0")
//   - each child carries `parentKey` (the local id of its parent)
// The ingest path (src/app/api/ingest/route.ts) inserts parents first, maps each
// returned row id back to its local key, then inserts children with a resolved
// `parent_id`. Chunks with no parent (structured records, fallback splits) simply
// carry neither field.

export interface Chunk {
  content: string;
  /** Resolved parent DB id. Normally set by the ingest path, not by chunking. */
  parentId?: string;
  /** Local id of THIS chunk, set on parent chunks so children can point at it. */
  key?: string;
  /** Local id of this chunk's parent, set on child chunks (links to a parent's `key`). */
  parentKey?: string;
  metadata: Record<string, unknown>;
}

// Rough token estimate (about 4 chars per token). Replace with a real tokenizer if needed.
const approxTokens = (s: string) => Math.ceil(s.length / 4);

// Recursive character split with overlap. Baseline for documents and markdown.
export function splitRecursive(text: string, targetTokens = 450, overlap = 60): string[] {
  const targetChars = targetTokens * 4;
  // Overlap must be smaller than the window, or the cursor can never move
  // forward. Clamp it so a mis-tuned call can't wedge the loop.
  const overlapChars = Math.min(overlap * 4, targetChars - 1);
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + targetChars, text.length);
    // Prefer breaking on a paragraph or sentence boundary within the window.
    const slice = text.slice(i, end);
    const lastBreak = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "));
    if (lastBreak > targetChars * 0.5 && end < text.length) end = i + lastBreak + 1;

    out.push(text.slice(i, end).trim());

    // Reached the end of the text — done. (Without this the last window,
    // whose `end` equals text.length, would re-slice the same tail forever.)
    if (end >= text.length) break;

    // Advance with overlap, but guarantee forward progress: if the overlapped
    // cursor wouldn't move past where we started this window, jump to `end`.
    const next = end - overlapChars;
    i = next > i ? next : end;
  }
  return out.filter(Boolean);
}

// One structured record (a call score / coaching note) becomes one natural-language
// chunk. Robust to arbitrary record shapes: nested objects and arrays are flattened
// into readable clauses, empty values dropped, so the embedding gets clean prose.
//
// When the well-known scoring fields are present we produce a purpose-built
// sentence ("Call {id} scored {score}/100; strong on {..}; weak on {..};
// recommendation: {..}"); otherwise we fall back to generic "key: value" clauses.
export function serializeRecord(record: Record<string, unknown>): string {
  if (!record || typeof record !== "object") return String(record ?? "");

  const parts: string[] = [];

  // Preferred, human-readable framing for call-scoring / coaching records.
  const id = firstDefined(record, ["id", "call_id", "callId", "record_id"]);
  const score = firstDefined(record, ["score", "overall_score", "rating"]);
  if (id != null || score != null) {
    const lead: string[] = [];
    if (id != null) lead.push(`Call ${stringify(id)}`);
    if (score != null) lead.push(`${lead.length ? "" : "Call "}scored ${stringify(score)}/100`.trim());
    if (lead.length) parts.push(lead.join(" ").replace(/\s+/g, " ").trim());

    const strengths = firstDefined(record, ["strengths", "strong_points", "did_well"]);
    if (strengths != null) parts.push(`strong on ${stringify(strengths)}`);
    const weaknesses = firstDefined(record, ["weaknesses", "weak_points", "areas_to_improve"]);
    if (weaknesses != null) parts.push(`weak on ${stringify(weaknesses)}`);
    const recommendation = firstDefined(record, ["recommendation", "recommendations", "coaching", "advice"]);
    if (recommendation != null) parts.push(`recommendation: ${stringify(recommendation)}`);
  }

  // Consumed keys we have already framed above (avoid repeating them generically).
  const consumed = new Set([
    "id", "call_id", "callId", "record_id",
    "score", "overall_score", "rating",
    "strengths", "strong_points", "did_well",
    "weaknesses", "weak_points", "areas_to_improve",
    "recommendation", "recommendations", "coaching", "advice",
  ]);

  // Generic clauses for every remaining populated field.
  for (const [k, v] of Object.entries(record)) {
    if (consumed.has(k)) continue;
    if (v == null || v === "") continue;
    const value = stringify(v);
    if (!value) continue;
    parts.push(`${humanizeKey(k)}: ${value}`);
  }

  return parts.join("; ");
}

// Entry point: choose the strategy by source type. Returns child chunks (searched)
// and, for structure-rich documents, their parent chunks too (metadata.is_parent).
export function chunkDocument(
  text: string,
  sourceType: string,
  metadata: Record<string, unknown> = {}
): Chunk[] {
  if (sourceType === "call_score" || sourceType === "coaching") {
    // One record -> one chunk. `text` is already the serialized record (see
    // serializeRecord, called by the ingest/pull path).
    const content = text.trim();
    return [{ content, metadata: { ...metadata, source_type: sourceType, tokens: approxTokens(content) } }];
  }

  if (sourceType === "document") {
    // Structure-aware: split on markdown headings into parent sections, then into
    // child chunks that link back to their parent.
    return chunkMarkdown(text, metadata);
  }

  // Transcripts and any unknown type: recursive fallback, no parents.
  // TODO: for transcripts, split on speaker turns with 20-50% overlap.
  return splitRecursive(text).map((content) => ({
    content,
    metadata: { ...metadata, source_type: sourceType, tokens: approxTokens(content) },
  }));
}

// ---- markdown / document chunking --------------------------------------------

interface Section {
  heading: string; // the heading line (e.g. "## Objection handling"), or "" for a preamble
  body: string;    // heading + following text, trimmed
}

// Split markdown into sections on ATX headings (# .. ######). Text before the
// first heading becomes a leading section with an empty heading.
function splitMarkdownSections(text: string): Section[] {
  const lines = text.split(/\r?\n/);
  const sections: Section[] = [];
  let heading = "";
  let buf: string[] = [];

  const flush = () => {
    const body = ((heading ? heading + "\n" : "") + buf.join("\n")).trim();
    if (body) sections.push({ heading, body });
  };

  for (const line of lines) {
    if (/^#{1,6}\s+\S/.test(line)) {
      flush();
      heading = line.trim();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

function chunkMarkdown(text: string, metadata: Record<string, unknown>): Chunk[] {
  const sections = splitMarkdownSections(text);
  const out: Chunk[] = [];
  let parentN = 0;

  for (const section of sections) {
    const childTexts = splitRecursive(section.body, 400, 60);
    const headingText = section.heading || undefined;

    if (childTexts.length <= 1) {
      // Small section: a single searchable chunk, no separate parent needed.
      const content = childTexts[0] ?? section.body;
      out.push({
        content,
        metadata: { ...metadata, source_type: "document", heading: headingText, tokens: approxTokens(content) },
      });
      continue;
    }

    // Larger section: emit the whole section as a parent, plus its child chunks.
    const parentKey = `p${parentN++}`;
    out.push({
      key: parentKey,
      content: section.body,
      metadata: {
        ...metadata,
        source_type: "document",
        is_parent: true,
        heading: headingText,
        tokens: approxTokens(section.body),
      },
    });
    for (const content of childTexts) {
      out.push({
        content,
        parentKey,
        metadata: { ...metadata, source_type: "document", heading: headingText, tokens: approxTokens(content) },
      });
    }
  }

  // No headings and no content parsed -> plain recursive fallback.
  if (out.length === 0) {
    return splitRecursive(text).map((content) => ({
      content,
      metadata: { ...metadata, source_type: "document", tokens: approxTokens(content) },
    }));
  }
  return out;
}

// ---- serialization helpers ---------------------------------------------------

function firstDefined(record: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (record[k] != null && record[k] !== "") return record[k];
  }
  return undefined;
}

// Turn any value into a compact, readable string. Arrays become comma lists;
// objects become "k=v" clauses; primitives stringify directly.
function stringify(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) {
    return v.map((x) => stringify(x)).filter(Boolean).join(", ");
  }
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val != null && val !== "")
      .map(([k, val]) => `${humanizeKey(k)}=${stringify(val)}`)
      .join(", ");
  }
  return String(v).trim();
}

// "overall_score" / "overallScore" -> "overall score" for readable prose.
function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
}
