/** Keep rank order and annotations while removing repeated context. */
export function uniqueEvidence<T extends { id: string; content: string; document_id: string }>(chunks: T[], creative = false): T[] {
  const ids = new Set<string>();
  const texts = new Set<string>();
  const documents = new Map<string, number>();
  return chunks.filter(c => {
    const text = c.content.toLowerCase().replace(/\s+/g, " ").trim();
    if (ids.has(c.id) || (creative && text.length > 100 && texts.has(text))) return false;
    const count = documents.get(c.document_id) ?? 0;
    if (creative && count >= 2) return false;
    ids.add(c.id); texts.add(text); documents.set(c.document_id, count + 1);
    return true;
  });
}

/** Bound expanded context by its actual text, never by stale ingest token counts.
 * Prefer complete ranked passages. An oversized leading passage becomes an
 * explicitly marked excerpt, so it cannot silently consume the whole window. */
export function budgetEvidence<T extends { id: string; content: string }>(chunks: T[], maxChars = 48_000): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  let remaining = Math.max(0, Math.floor(maxChars));
  for (const chunk of chunks) {
    if (seen.has(chunk.id) || !chunk.content.trim()) continue;
    seen.add(chunk.id);
    if (chunk.content.length <= remaining) {
      out.push(chunk);
      remaining -= chunk.content.length;
    } else if (!out.length && remaining >= 1000) {
      const suffix = "\n[Source excerpt ends here; the remaining source was not supplied.]";
      // Reserve room for other sources; don't let one large parent monopolize it.
      const allowance = Math.min(12_000, remaining) - suffix.length;
      const prefix = chunk.content.slice(0, allowance);
      const boundary = Math.max(prefix.lastIndexOf("\n\n"), prefix.lastIndexOf(". "));
      const content = prefix.slice(0, boundary > allowance / 2 ? boundary : allowance) + suffix;
      out.push({ ...chunk, content });
      remaining -= content.length;
    }
  }
  return out;
}
