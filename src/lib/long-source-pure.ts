// Long sources (books, courses, reports) — the pure, CLIENT-SAFE half.
//
// A 350k-character book is not one knowledge object: each chapter is its own
// framework. The Add-knowledge wizard therefore splits a long source into
// top-level units and compiles them one by one. The split happens IN THE
// BROWSER (which already holds the extracted text), so megabytes of text never
// travel back to the server just to be outlined:
//
//   headingCandidates(text)        heading-like lines + their char offsets
//   outlineCandidates(text, c)     the short list sent to POST …/knowledge/outline
//                                  (index · text · next-line hint — no body text)
//   chaptersFromOutline(c, picks)  the model's picks → validated chapter starts
//   splitByOutline(text, chapters) chapter starts → contiguous LongSection[]
//   fallbackChapters(text)         deterministic split by size (no model / < 3 picks)
//
// Typography alone cannot tell a chapter title from a sub-heading (both are
// short Title-Case lines after a blank line), which is why a model picks the
// top-level ones from the candidate list (src/lib/long-source.ts). Nothing
// here touches the network, the DOM or an SDK — keep it that way so the wizard
// can import it and the unit tests need no mocks. Offsets always refer to the
// text exactly as given (never normalise it here, or the slices drift).

/** A source longer than this gets the wizard's "Long source" panel. */
export const LONG_SOURCE_CHARS = 40_000;
/** Most candidates one outline request may carry (the route enforces it too). */
export const MAX_OUTLINE_CANDIDATES = 600;
export const MAX_CANDIDATE_CHARS = 200;
/** A section shorter than this is merged into its neighbour. */
export const MIN_SECTION_CHARS = 1_500;
/** A section longer than this is sub-split ("Title (part 1/2)"). */
export const MAX_SECTION_CHARS = 30_000;
/** Target size of the deterministic fallback split. */
export const FALLBACK_SECTION_CHARS = 14_000;

export const FRONT_MATTER_TITLE = "Front matter";

export interface HeadingCandidate {
  /** 0-based line number. */
  line: number;
  /** Char offset of the line start in the text. */
  offset: number;
  /** The heading text (markdown `#`, emphasis and quotes stripped). */
  text: string;
}

/** What the outline route receives per candidate — never the body text. */
export interface OutlineCandidate {
  index: number;
  text: string;
  /** The next non-empty line: an epigraph or a first sentence helps tell a chapter from a sub-heading. */
  hint: string;
}

/** The model's pick: `index` refers to OutlineCandidate.index. */
export interface OutlinePick {
  index: number;
  title: string;
}

export interface ChapterStart {
  offset: number;
  title: string;
}

export interface LongSection {
  index: number;
  title: string;
  /** Char offsets into the source text: text.slice(start, end). Contiguous across sections. */
  start: number;
  end: number;
  text: string;
  chars: number;
  /** First ~220 chars of the body (the heading line itself skipped). */
  preview: string;
}

// ---------------------------------------------------------------------------
// Heading candidates
// ---------------------------------------------------------------------------

/** Title-case connectors: neither for nor against a heading ("The Five Stages of Awareness"). */
const MINOR_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "is", "nor", "of", "on", "or", "per", "the", "to", "via", "vs", "with"]);

/** Strip markdown heading marks, emphasis asterisks/underscores and wrapping quotes. */
export function cleanHeadingText(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/[*_`]+/g, "")
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether ONE line reads like a heading (length, no terminal punctuation, ≤ 10 words, ≥ 70% capitalised). */
export function looksLikeHeading(raw: string): boolean {
  const t = cleanHeadingText(raw);
  if (t.length < 4 || t.length > 70) return false;
  if (/[.,;:!?]$/.test(t)) return false;
  const words = t.split(" ").filter(Boolean);
  if (words.length === 0 || words.length > 10) return false;
  let counted = 0;
  let capitalised = 0;
  for (const w of words) {
    const letters = w.replace(/[^\p{L}]/gu, "");
    if (!letters) continue; // "99%", "&", "—"
    if (MINOR_WORDS.has(letters.toLowerCase()) && letters === letters.toLowerCase()) continue;
    counted++;
    // Capitalised ("Bonus", "No-Show") or ALL CAPS ("DM").
    if (letters[0] !== letters[0].toLowerCase() || (letters.length > 1 && letters === letters.toUpperCase() && letters !== letters.toLowerCase())) capitalised++;
  }
  if (counted === 0) return false;
  return capitalised / counted >= 0.7;
}

/**
 * Heading-like lines: 4–70 chars, no terminal `. , ; : ! ?`, ≤ 10 words, ≥ 70%
 * of the words capitalised (or ALL CAPS), preceded by a blank line (or the
 * start of the text). A markdown `# heading` qualifies on its own.
 */
export function headingCandidates(text: string): HeadingCandidate[] {
  const out: HeadingCandidate[] = [];
  let offset = 0;
  let line = 0;
  let prevBlank = true;
  while (offset <= text.length) {
    let end = text.indexOf("\n", offset);
    if (end < 0) end = text.length;
    const raw = text.slice(offset, end).replace(/\r$/, "");
    const trimmed = raw.trim();
    if (trimmed) {
      const markdown = /^#{1,3}\s+\S/.test(trimmed);
      if ((prevBlank || markdown) && (markdown ? cleanHeadingText(trimmed).length >= 2 && trimmed.length <= 120 : looksLikeHeading(trimmed))) {
        out.push({ line, offset, text: cleanHeadingText(trimmed) });
      }
    }
    prevBlank = !trimmed;
    if (end >= text.length) break;
    offset = end + 1;
    line++;
  }
  return out;
}

/** The next non-empty line after `offset`'s own line (≤ max chars). */
function nextLine(text: string, offset: number, max = 120): string {
  let i = text.indexOf("\n", offset);
  while (i >= 0 && i < text.length) {
    let end = text.indexOf("\n", i + 1);
    if (end < 0) end = text.length;
    const l = text.slice(i + 1, end).trim();
    if (l) return l.replace(/\s+/g, " ").slice(0, max);
    if (end >= text.length) break;
    i = end;
  }
  return "";
}

/**
 * The list the outline route receives. `index` is the position in
 * `candidates`, so the picks map straight back to offsets. Over the cap the
 * list is thinned evenly — a very long source loses some sub-headings, and the
 * size rules in splitByOutline still bound every section.
 */
export function outlineCandidates(text: string, candidates: HeadingCandidate[], max = MAX_OUTLINE_CANDIDATES): OutlineCandidate[] {
  const all = candidates.map((c, index) => ({ index, text: c.text.slice(0, MAX_CANDIDATE_CHARS), hint: nextLine(text, c.offset) }));
  if (all.length <= max) return all;
  const step = all.length / max;
  const kept: OutlineCandidate[] = [];
  for (let i = 0; i < max; i++) kept.push(all[Math.floor(i * step)]);
  return kept;
}

/** The model's picks → chapter starts: known indexes only, reading order, no repeats. */
export function chaptersFromOutline(candidates: HeadingCandidate[], picks: OutlinePick[]): ChapterStart[] {
  const seen = new Set<number>();
  const out: ChapterStart[] = [];
  for (const p of [...picks].sort((a, b) => a.index - b.index)) {
    if (!Number.isInteger(p.index) || p.index < 0 || p.index >= candidates.length || seen.has(p.index)) continue;
    seen.add(p.index);
    const c = candidates[p.index];
    const title = cleanHeadingText(typeof p.title === "string" ? p.title : "").slice(0, 120) || c.text;
    out.push({ offset: c.offset, title });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

/** Chars of real prose (lines of ≥ 8 words) — a cover, a copyright line or a table of contents has almost none. */
export function proseChars(text: string): number {
  let n = 0;
  for (const l of text.split("\n")) {
    const t = l.trim();
    if (t.split(/\s+/).length >= 8) n += t.length;
  }
  return n;
}

/**
 * The best cut near `target` inside (lo, hi): a heading candidate, else a
 * paragraph break, else a line break — each only within `window` of the
 * target — else the target itself.
 */
function nearestBoundary(text: string, target: number, lo: number, hi: number, offsets: number[], window: number): number {
  const within = (o: number) => o > lo && o < hi && Math.abs(o - target) <= window;
  let best = -1;
  for (const o of offsets) if (within(o) && (best < 0 || Math.abs(o - target) < Math.abs(best - target))) best = o;
  if (best >= 0) return best;
  for (const sep of ["\n\n", "\n"]) {
    const before = text.lastIndexOf(sep, target);
    const after = text.indexOf(sep, target);
    const cands = [before >= 0 ? before + sep.length : -1, after >= 0 ? after + sep.length : -1].filter(within);
    if (cands.length) return cands.reduce((a, b) => (Math.abs(a - target) <= Math.abs(b - target) ? a : b));
  }
  return Math.min(Math.max(target, lo + 1), hi - 1);
}

/** Cut [start, end) into n roughly equal parts at the best boundaries. Returns the n-1 inner cuts. */
function evenCuts(text: string, start: number, end: number, n: number, offsets: number[]): number[] {
  const cuts: number[] = [];
  const size = (end - start) / n;
  let lo = start;
  for (let i = 1; i < n; i++) {
    const cut = nearestBoundary(text, Math.round(start + i * size), lo, end, offsets, Math.round(size * 0.4));
    if (cut <= lo || cut >= end) continue;
    cuts.push(cut);
    lo = cut;
  }
  return cuts;
}

function preview(body: string, title: string): string {
  const lines = body.split("\n");
  // Skip the heading line itself when the section starts with it.
  const first = lines.findIndex((l) => l.trim());
  if (first >= 0 && cleanHeadingText(lines[first].trim()).toLowerCase() === baseSectionTitle(title).toLowerCase()) lines.splice(0, first + 1);
  const flat = lines.join(" ").replace(/\s+/g, " ").trim();
  return flat.length > 220 ? `${flat.slice(0, 220).trimEnd()}…` : flat;
}

/** "The Monopoly Board (part 2/3)" → "The Monopoly Board". */
export function baseSectionTitle(title: string): string {
  return title.replace(/\s*\(part \d+\/\d+\)$/i, "").trim();
}

/** Titles that name a position, not a teaching — the compiler names those objects itself. */
export function isGenericSectionTitle(title: string): boolean {
  const t = baseSectionTitle(title).toLowerCase();
  return t === FRONT_MATTER_TITLE.toLowerCase() || /^(introduction|intro|preface|foreword|prologue|conclusion|epilogue|afterword|appendix(\s+\w+)?|acknowledge?ments|about the author)$/.test(t) || /^(part|chapter|module|section|lesson|unit)\s+([\divxlc]+|one|two|three|four|five|six|seven|eight|nine|ten)\b/.test(t);
}

/**
 * Chapter starts → contiguous sections. Section i runs from chapter i's offset
 * to chapter i+1's. Text before the first chapter becomes "Front matter" only
 * when it holds ≥ 1,500 chars of real prose (else it is dropped); a section
 * under 1,500 chars merges into the next one (the last one into the previous);
 * a section over 30,000 chars is sub-split at heading candidates into
 * "Title (part 1/2)". Sections never overlap and, from the first one's start,
 * cover the text to its end.
 */
export function splitByOutline(text: string, chapters: ChapterStart[], candidates?: HeadingCandidate[]): LongSection[] {
  const starts = [...chapters]
    .filter((c) => Number.isFinite(c.offset) && c.offset >= 0 && c.offset < text.length)
    .sort((a, b) => a.offset - b.offset)
    .filter((c, i, arr) => i === 0 || c.offset !== arr[i - 1].offset);
  if (!text.trim()) return [];
  if (starts.length === 0) starts.push({ offset: 0, title: "Part 1" });

  // 1. Ranges, with the front-matter rule.
  let ranges: { start: number; end: number; title: string }[] = [];
  if (starts[0].offset > 0 && proseChars(text.slice(0, starts[0].offset)) >= MIN_SECTION_CHARS) {
    ranges.push({ start: 0, end: starts[0].offset, title: FRONT_MATTER_TITLE });
  }
  starts.forEach((c, i) => ranges.push({ start: c.offset, end: i + 1 < starts.length ? starts[i + 1].offset : text.length, title: c.title.trim() || `Part ${i + 1}` }));

  // 2. Merge small sections forward (the substantive neighbour keeps its title).
  const merged: typeof ranges = [];
  let carried = -1; // start of the small section(s) waiting for a substantive neighbour
  ranges.forEach((r, i) => {
    const start = carried >= 0 ? carried : r.start;
    if (i < ranges.length - 1 && text.slice(start, r.end).trim().length < MIN_SECTION_CHARS) {
      carried = start;
      return;
    }
    merged.push({ start, end: r.end, title: r.title });
    carried = -1;
  });
  // A small tail joins the section before it.
  if (merged.length > 1) {
    const last = merged[merged.length - 1];
    if (text.slice(last.start, last.end).trim().length < MIN_SECTION_CHARS) {
      merged[merged.length - 2].end = last.end;
      merged.pop();
    }
  }
  ranges = merged;

  // 3. Sub-split large sections at heading candidates (paragraph breaks when there are none).
  const offsets = (candidates ?? headingCandidates(text)).map((c) => c.offset);
  const out: LongSection[] = [];
  const push = (start: number, end: number, title: string) => {
    const body = text.slice(start, end);
    out.push({ index: out.length, title, start, end, text: body, chars: body.length, preview: preview(body, title) });
  };
  for (const r of ranges) {
    const len = r.end - r.start;
    if (len <= MAX_SECTION_CHARS) {
      push(r.start, r.end, r.title);
      continue;
    }
    const n = Math.ceil(len / MAX_SECTION_CHARS);
    const cuts = evenCuts(text, r.start, r.end, n, offsets);
    const bounds = [r.start, ...cuts, r.end];
    for (let i = 0; i + 1 < bounds.length; i++) push(bounds[i], bounds[i + 1], bounds.length > 2 ? `${r.title} (part ${i + 1}/${bounds.length - 1})` : r.title);
  }
  return out;
}

/**
 * Deterministic outline when the model is unavailable (demo mode, no key,
 * outage) or found fewer than 3 chapters: ~14k-char parts cut at the nearest
 * heading candidate / paragraph break, titled "Part N — <first heading inside>".
 */
export function fallbackChapters(text: string, candidates?: HeadingCandidate[], size = FALLBACK_SECTION_CHARS): ChapterStart[] {
  const cands = candidates ?? headingCandidates(text);
  const n = Math.max(1, Math.round(text.length / size));
  const bounds = [0, ...evenCuts(text, 0, text.length, n, cands.map((c) => c.offset)), text.length];
  const out: ChapterStart[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const first = cands.find((c) => c.offset >= bounds[i] && c.offset < bounds[i + 1] && !/^(cover|contents|table of contents|copyright)$/i.test(c.text));
    out.push({ offset: bounds[i], title: first ? `Part ${i + 1} — ${first.text}` : `Part ${i + 1}` });
  }
  return out;
}

/**
 * Cheap, stable key for a source (FNV-1a over title + length + the first 200
 * chars) — the wizard files a batch's progress under it in localStorage so a
 * reload can resume. Not a security hash.
 */
export function sourceKey(title: string, text: string): string {
  const s = `${title.trim().toLowerCase()}|${text.length}|${text.slice(0, 200)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
