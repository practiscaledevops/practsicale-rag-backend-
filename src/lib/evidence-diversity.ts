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
