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

  // A long free-text report (e.g. the call-scoring `full_report` markdown) is
  // kept VERBATIM and appended after the structured summary, so downstream
  // chunking can split it structure-aware instead of flattening 16KB into one
  // giant clause. Captured here and excluded from the generic key:value loop.
  const reportRaw = firstDefined(record, ["full_report", "report", "full_report_md", "analysis"]);
  const report = typeof reportRaw === "string" && reportRaw.trim() ? reportRaw.trim() : "";

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
    // The verbatim report is appended separately, not flattened.
    "full_report", "report", "full_report_md", "analysis",
  ]);

  // Generic clauses for every remaining populated field.
  for (const [k, v] of Object.entries(record)) {
    if (consumed.has(k)) continue;
    if (v == null || v === "") continue;
    const value = stringify(v);
    if (!value) continue;
    parts.push(`${humanizeKey(k)}: ${value}`);
  }

  const summary = parts.join("; ");
  // Structured summary first, then the verbatim report (markdown preserved).
  return report ? `${summary}\n\n${report}` : summary;
}

// Entry point: choose the strategy by source type. Returns child chunks (searched)
// and, for structure-rich documents, their parent chunks too (metadata.is_parent).
export function chunkDocument(
  text: string,
  sourceType: string,
  metadata: Record<string, unknown> = {}
): Chunk[] {
  if (sourceType === "call_score" || sourceType === "coaching") {
    const content = text.trim();
    // If the record carries a markdown report (ATX headings), split it: a compact
    // structured-summary chunk (great for "what did X score") + structure-aware
    // chunks of the report (great for "why did the close fail"). Otherwise a
    // small structured record stays a single chunk.
    const headingIdx = content.search(/^#{1,6}\s+\S/m);
    if (headingIdx !== -1) {
      const summary = content.slice(0, headingIdx).trim();
      const report = content.slice(headingIdx);
      const chunks: Chunk[] = [];
      if (summary) {
        chunks.push({
          content: summary,
          metadata: { ...metadata, source_type: sourceType, is_summary: true, tokens: approxTokens(summary) },
        });
      }
      chunks.push(...chunkMarkdown(report, metadata, sourceType));
      return chunks;
    }
    return [{ content, metadata: { ...metadata, source_type: sourceType, tokens: approxTokens(content) } }];
  }

  if (sourceType === "document") {
    // Structure-aware: split on markdown headings into parent sections, then into
    // child chunks that link back to their parent.
    return chunkMarkdown(text, metadata);
  }

  // Transcripts: a summary chunk (built from metadata + the first/last turns)
  // followed by time-anchored, turn-aligned body chunks. See chunkTranscript.
  if (sourceType === "transcript") {
    return chunkTranscript(text, metadata);
  }

  // Any unknown type: recursive fallback, no parents.
  return splitRecursive(text).map((content) => ({
    content,
    metadata: { ...metadata, source_type: sourceType, tokens: approxTokens(content) },
  }));
}

// ---- transcript chunking -----------------------------------------------------
//
// A call transcript is a run of timestamped speaker turns:
//   0:17 - Sherman Mathews
//     Good afternoon, Cliff...
//   0:19 - Cliff A
//     Good...
// Turns are kept WHOLE (never split inside one). We emit a compact summary chunk
// first — the call's identity (built from metadata) plus the first/last turns —
// so "what happened at the start/end of X's call on 22 Sept" lands immediately;
// then we group consecutive turns into ~1,400-token chunks, each prefixed with a
// self-describing, time-anchored locator, with ~15% turn overlap so an answer
// spanning a boundary is not cut.

/** One timestamped speaker turn parsed from a transcript. */
export interface TranscriptTurn {
  /** The turn's start timestamp exactly as written, e.g. "0:17" or "1:02:40". */
  start: string;
  /** `start` expressed in whole seconds (for ordering / spans). */
  startSeconds: number;
  /** Speaker label as written (may carry an email or "(email)"); "" if absent. */
  speaker: string;
  /** The header line, e.g. "0:17 - Sherman Mathews". */
  header: string;
  /** The turn's spoken body (the indented lines under the header), trimmed. */
  body: string;
  /** header + body — the full turn text. */
  text: string;
}

// A transcript header line: a timestamp (M:SS, MM:SS or H:MM:SS), a dash, then
// the speaker. Anchored to the line start (multiline) so a time inside spoken
// text is never mistaken for a new turn.
const TURN_HEADER_RE = /^(\d{1,2}:\d{2}(?::\d{2})?)\s*-\s*(.*)$/;

/** ~tokens per transcript body chunk, and the turn overlap between neighbours. */
const TRANSCRIPT_CHUNK_TOKENS = 1400;
const TRANSCRIPT_OVERLAP_RATIO = 0.15;
// Cap on the carried-forward overlap prefix so target + overlap stays below the
// ~1,800-token safety ceiling and a long turn is never duplicated wholesale.
const TRANSCRIPT_OVERLAP_MAX_TOKENS = 350;

function timestampToSeconds(ts: string): number {
  const parts = ts.split(":").map((n) => Number(n));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
}

/**
 * Parse a transcript into timestamped turns. Text before the first timestamp
 * (e.g. an ingest header block) is preamble and skipped — the turns are what we
 * chunk. Pure and side-effect free; unit-tested.
 */
export function parseTranscriptTurns(text: string): TranscriptTurn[] {
  const lines = (text ?? "").split(/\r?\n/);
  const turns: TranscriptTurn[] = [];
  let cur: { start: string; speaker: string; header: string; body: string[] } | null = null;

  const flush = () => {
    if (!cur) return;
    const body = cur.body.join("\n").trim();
    const header = cur.header.trim();
    turns.push({
      start: cur.start,
      startSeconds: timestampToSeconds(cur.start),
      speaker: cur.speaker.trim(),
      header,
      body,
      text: body ? `${header}\n${body}` : header,
    });
  };

  for (const line of lines) {
    const m = TURN_HEADER_RE.exec(line);
    if (m) {
      flush();
      cur = { start: m[1], speaker: m[2] ?? "", header: line.trim(), body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
    // else: preamble before the first turn — skipped.
  }
  flush();
  return turns;
}

function metaStr(metadata: Record<string, unknown>, key: string): string {
  const v = metadata[key];
  return v == null ? "" : String(v).trim();
}

/** First non-empty recording URL from `recording_links` (array or string). */
function firstRecordingLink(metadata: Record<string, unknown>): string {
  const links = metadata.recording_links;
  if (Array.isArray(links)) {
    const first = links.find((l) => typeof l === "string" && l.trim());
    return typeof first === "string" ? first.trim() : "";
  }
  return typeof links === "string" ? links.trim() : "";
}

/** The call's identity line for a locator, e.g. "Sherman Mathews → Cliff A · NEMT · 2026-09-22". */
function transcriptLocatorBase(metadata: Record<string, unknown>): string {
  const consultant = metaStr(metadata, "consultant_name") || metaStr(metadata, "consultant") || "Consultant";
  const prospect = metaStr(metadata, "prospect_name") || "Prospect";
  const practice = metaStr(metadata, "practice_type");
  const callDate = metaStr(metadata, "call_date") || metaStr(metadata, "created_at");
  return [`${consultant} → ${prospect}`, practice, callDate].filter(Boolean).join(" · ");
}

/** Summary chunk: the call's identity (from metadata) + its first/last turns. */
function transcriptSummary(turns: TranscriptTurn[], metadata: Record<string, unknown>): string {
  const consultant = metaStr(metadata, "consultant_name") || metaStr(metadata, "consultant") || "Unknown consultant";
  const prospect = metaStr(metadata, "prospect_name") || "Unknown prospect";
  const practice = metaStr(metadata, "practice_type");
  const callDate = metaStr(metadata, "call_date") || metaStr(metadata, "created_at");
  const outcome = metaStr(metadata, "call_outcome");
  const score = metaStr(metadata, "overall_score");
  const band = metaStr(metadata, "performance_band");
  const duration = metaStr(metadata, "call_duration_minutes");
  const recording = firstRecordingLink(metadata);

  const header = [
    `Call transcript — ${consultant} → ${prospect}`,
    practice ? `Practice type: ${practice}` : "",
    callDate ? `Call date: ${callDate}` : "",
    outcome ? `Outcome: ${outcome}` : "",
    score ? `Score: ${score}/100${band ? ` (${band})` : ""}` : band ? `Band: ${band}` : "",
    duration ? `Duration: ${duration} min` : "",
    recording ? `Recording: ${recording}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const head = turns.slice(0, 2).map((t) => t.text).join("\n\n");
  // Only add a distinct "end" block when the tail turns aren't already the head.
  const tail = turns.length > 4 ? turns.slice(-2).map((t) => t.text).join("\n\n") : "";
  const parts = [header, head ? `Start of call:\n${head}` : ""];
  if (tail) parts.push(`End of call:\n${tail}`);
  return parts.filter(Boolean).join("\n\n");
}

function chunkTranscript(text: string, metadata: Record<string, unknown>): Chunk[] {
  const turns = parseTranscriptTurns(text);
  // Not a timestamped transcript (or empty) → recursive fallback so nothing is lost.
  if (turns.length === 0) {
    return splitRecursive(text).map((content) => ({
      content,
      metadata: { ...metadata, source_type: "transcript", tokens: approxTokens(content) },
    }));
  }

  const base = { ...metadata, source_type: "transcript" };
  const chunks: Chunk[] = [];

  // 1) Summary chunk first.
  const summary = transcriptSummary(turns, metadata);
  chunks.push({ content: summary, metadata: { ...base, is_summary: true, tokens: approxTokens(summary) } });

  // 2) Body chunks: each chunk is [overlap turns from the previous chunk] +
  //    [new turns filling up to ~TRANSCRIPT_CHUNK_TOKENS], prefixed with a
  //    time-anchored locator. The overlap (~15% of the previous chunk's new
  //    turns) is PREPENDED to the next chunk — never emitted on its own — so
  //    there are no near-empty chunks and an answer spanning a boundary isn't
  //    cut. A turn is never split; a turn larger than the target becomes its
  //    own chunk (with no overlap prefix, so the safety ceiling holds).
  const turnTokens = turns.map((t) => approxTokens(t.text));
  const locBase = transcriptLocatorBase(metadata);
  let i = 0;
  let prevTail: TranscriptTurn[] = [];
  while (i < turns.length) {
    // Don't stack an overlap prefix on a turn that already exceeds the target —
    // that would push the chunk past the safety ceiling.
    const startBig = turnTokens[i] > TRANSCRIPT_CHUNK_TOKENS;
    const group: TranscriptTurn[] = startBig ? [] : [...prevTail];
    let tokens = group.reduce((s, t) => s + approxTokens(t.text), 0);
    const startNew = i;
    while (i < turns.length) {
      // Always take at least one NEW turn, even if it alone exceeds the target.
      if (i > startNew && tokens + turnTokens[i] > TRANSCRIPT_CHUNK_TOKENS) break;
      group.push(turns[i]);
      tokens += turnTokens[i];
      i++;
    }

    const first = group[0];
    const last = group[group.length - 1];
    const span = first.start === last.start ? first.start : `${first.start}–${last.start}`;
    const locator = `[${[locBase, span].filter(Boolean).join(" · ")}]`;
    const content = `${locator}\n${group.map((t) => t.text).join("\n\n")}`;
    chunks.push({
      content,
      metadata: {
        ...base,
        is_transcript_body: true,
        turn_start: first.start,
        turn_end: last.start,
        tokens: approxTokens(content),
      },
    });

    if (i >= turns.length) break;
    // Carry the last ~15% of THIS chunk's new turns forward as the next chunk's
    // prefix. Bound its size (drop the oldest, then all, if it's too big) so a
    // long turn is never duplicated wholesale into the next chunk.
    const newTurns = turns.slice(startNew, i);
    let ov = newTurns.length > 1 ? Math.max(1, Math.round(newTurns.length * TRANSCRIPT_OVERLAP_RATIO)) : 0;
    ov = Math.min(ov, newTurns.length - 1);
    let tail = ov > 0 ? newTurns.slice(newTurns.length - ov) : [];
    let tailTokens = tail.reduce((s, t) => s + approxTokens(t.text), 0);
    while (tail.length > 1 && tailTokens > TRANSCRIPT_OVERLAP_MAX_TOKENS) {
      tailTokens -= approxTokens(tail[0].text);
      tail = tail.slice(1);
    }
    prevTail = tail.length === 1 && tailTokens > TRANSCRIPT_OVERLAP_MAX_TOKENS ? [] : tail;
  }

  return chunks;
}

// ---- knowledge-object (semantic) chunking ------------------------------------
//
// A compiled intelligence object is NOT cut every N tokens. It is chunked by
// complete ideas: every heading section (#, ##, ###) becomes one retrievable
// chunk that inherits the object's metadata (ref, class, domain, type, subtype,
// authority…) and stays linked to the whole object. Token limits are only a
// SAFETY boundary — an unusually long section becomes a parent with children.

/** Safety boundary (approx tokens) above which a section is sub-split. */
const OBJECT_SECTION_SAFETY_TOKENS = 900;

/** Strip a leading YAML frontmatter block; returns the body. */
export function stripFrontmatter(markdown: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown);
  return (m ? markdown.slice(m[0].length) : markdown).trimStart();
}

/**
 * Chunk a compiled knowledge object's markdown into semantic sections. Every
 * chunk carries `metadata` (the object identity the caller passes) plus the
 * section heading, so retrieval can land on "MG-001 → Diagnostic" directly.
 */
export function chunkKnowledgeObject(
  markdown: string,
  metadata: Record<string, unknown> = {}
): Chunk[] {
  const body = stripFrontmatter(markdown).trim();
  if (!body) return [];
  const lines = body.split(/\r?\n/);

  interface Sec { heading: string; level: number; lines: string[] }
  const sections: Sec[] = [];
  let cur: Sec = { heading: "", level: 0, lines: [] };
  for (const line of lines) {
    const h = /^(#{1,3})\s+(\S.*)$/.exec(line);
    if (h) {
      if (cur.heading || cur.lines.some((l) => l.trim())) sections.push(cur);
      cur = { heading: h[2].trim(), level: h[1].length, lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  if (cur.heading || cur.lines.some((l) => l.trim())) sections.push(cur);

  // No headings at all → structure-unaware fallback.
  if (sections.every((s) => !s.heading)) return chunkMarkdown(body, metadata);

  const out: Chunk[] = [];
  let index = 0;
  let parentN = 0;
  // Merge a tiny title-only H1 preamble into the following section for context.
  let titleLine = "";
  for (const s of sections) {
    const text = s.lines.join("\n").trim();
    if (s.level === 1 && !text && !titleLine) {
      titleLine = `# ${s.heading}`;
      continue;
    }
    if (!s.heading && text.length < 80) continue; // stray preamble noise

    const headingLine = s.heading ? `${"#".repeat(Math.max(1, s.level))} ${s.heading}` : "";
    const content = [titleLine && index === 0 ? titleLine : "", headingLine, text].filter(Boolean).join("\n").trim();
    if (!content) continue;
    const base = {
      ...metadata,
      source_type: "document",
      is_object_section: true,
      section: s.heading || "Preamble",
      section_index: index++,
      heading: headingLine || undefined,
    };

    if (approxTokens(content) <= OBJECT_SECTION_SAFETY_TOKENS) {
      out.push({ content, metadata: { ...base, tokens: approxTokens(content) } });
      continue;
    }
    // Safety split: the whole section is the parent; children are searched.
    const parentKey = `p${parentN++}`;
    out.push({ key: parentKey, content, metadata: { ...base, is_parent: true, tokens: approxTokens(content) } });
    for (const child of splitRecursive(content, 500, 60)) {
      out.push({ content: child, parentKey, metadata: { ...base, tokens: approxTokens(child) } });
    }
  }
  return out.length > 0 ? out : chunkMarkdown(body, metadata);
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

  // Split only on top-level headings (# and ##). Deeper sub-headings (###+) stay
  // as body text within their parent section, so tightly-related content is kept
  // together — e.g. a product name and its price tiers, or a scorecard phase and
  // its detail — instead of being orphaned into separate chunks. Long sections
  // are still sub-split into child chunks by chunkMarkdown's recursive splitter.
  for (const line of lines) {
    if (/^#{1,2}\s+\S/.test(line)) {
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

function chunkMarkdown(
  text: string,
  metadata: Record<string, unknown>,
  sourceType = "document"
): Chunk[] {
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
        metadata: { ...metadata, source_type: sourceType, heading: headingText, tokens: approxTokens(content) },
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
        source_type: sourceType,
        is_parent: true,
        heading: headingText,
        tokens: approxTokens(section.body),
      },
    });
    for (const content of childTexts) {
      out.push({
        content,
        parentKey,
        metadata: { ...metadata, source_type: sourceType, heading: headingText, tokens: approxTokens(content) },
      });
    }
  }

  // No headings and no content parsed -> plain recursive fallback.
  if (out.length === 0) {
    return splitRecursive(text).map((content) => ({
      content,
      metadata: { ...metadata, source_type: sourceType, tokens: approxTokens(content) },
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
