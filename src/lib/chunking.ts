// Chunking strategies by source type.
// Child chunks are searched; a parent id links them to a larger section.

export interface Chunk {
  content: string;
  parentId?: string;
  metadata: Record<string, unknown>;
}

// Rough token estimate (about 4 chars per token). Replace with a real tokenizer if needed.
const approxTokens = (s: string) => Math.ceil(s.length / 4);

// Recursive character split with overlap. Baseline for documents and markdown.
export function splitRecursive(text: string, targetTokens = 450, overlap = 60): string[] {
  const targetChars = targetTokens * 4;
  const overlapChars = overlap * 4;
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + targetChars, text.length);
    // try to break on a paragraph or sentence boundary
    const slice = text.slice(i, end);
    const lastBreak = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "));
    if (lastBreak > targetChars * 0.5 && end < text.length) end = i + lastBreak + 1;
    out.push(text.slice(i, end).trim());
    i = end - overlapChars;
    if (i < 0) i = 0;
  }
  return out.filter(Boolean);
}

// One structured record (a call score) becomes one serialized chunk.
export function serializeRecord(record: Record<string, unknown>): string {
  return Object.entries(record)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
}

// Entry point: choose the strategy by source type.
export function chunkDocument(
  text: string,
  sourceType: string,
  metadata: Record<string, unknown> = {}
): Chunk[] {
  if (sourceType === "call_score" || sourceType === "coaching") {
    return [{ content: text, metadata: { ...metadata, source_type: sourceType } }];
  }
  // TODO: for transcripts, split on speaker turns with 20-50% overlap.
  return splitRecursive(text).map((content) => ({
    content,
    metadata: { ...metadata, source_type: sourceType, tokens: approxTokens(content) },
  }));
}
