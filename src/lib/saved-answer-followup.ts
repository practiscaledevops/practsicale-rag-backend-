import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScopeFilters } from "@/lib/auth/scope";
import { extractCitationIds } from "@/lib/faithfulness";
import { knowledgeScopeDef, type KnowledgeScopeDef } from "@/lib/knowledge-scopes";
import { LANE_CLASS, type Lane } from "@/lib/work-modes";

type Turn = { role: string; content: string };
type Operation = "table" | "shorten" | "explain";
export type SavedAnswerPlan = { operation: Operation; text: string; citationIds: string[]; point?: number };

type DocumentInfo = { title: string; created_at: string; updated_at: string | null };
export type SavedAnswerSource = { id: string; document_id: string; content: string; documents: DocumentInfo };
type SourceRow = SavedAnswerSource & {
  intelligence_class?: string | null;
  source_type?: string;
  documents: DocumentInfo & {
    source_type?: string;
    call_date?: string | null;
    call_date_basis?: string | null;
    reported_call_date?: string | null;
    overall_score?: number | string | null;
    performance_band?: string | null;
  };
};
type SavedCitationSource = SourceRow & { source_type: "document" | "call_score" };

const referent = "(?:it|that|this|the (?:last|previous) (?:answer|reply))";
const tableRequest = new RegExp(`^(?:turn ${referent} into (?:a )?table|(?:put|show|present|format) ${referent} (?:in|as) (?:a )?table)$`, "i");
const shortenRequest = new RegExp(`^(?:make ${referent} (?:shorter|more concise)|shorten ${referent}|summa(?:rize|rise) ${referent})$`, "i");
const explanationRequest = new RegExp(`^explain ${referent}(?: (?:in (?:plain|simple) (?:English|terms)|a bit more))?$`, "i");
const numberWords = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const pointRequest = /^explain (?:point|step|item) (\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)(?: (?:in (?:plain|simple) (?:English|terms)|a bit more))?$/i;
const fullId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const shortId = /^[a-f0-9]{8}$/i;
const savedTableHeader = "| Point | Details |\n| --- | --- |";

/** Only explicit requests to transform the immediately preceding answer. */
export function planSavedAnswerFollowup(turns: readonly Turn[]): SavedAnswerPlan | null {
  const request = turns.at(-1);
  const previous = turns.at(-2);
  if (request?.role !== "user" || previous?.role !== "assistant" || previous.content.length > 12_000) return null;
  const query = request.content.trim().replace(/^please\s+/i, "").replace(/[.!?]+$/, "").replace(/,?\s+please$/i, "");
  const pointMatch = pointRequest.exec(query)?.[1].toLowerCase();
  const point = pointMatch ? (Number(pointMatch) || numberWords.indexOf(pointMatch) + 1) : undefined;
  const operation = tableRequest.test(query) ? "table" : shortenRequest.test(query) ? "shorten"
    : point || explanationRequest.test(query) ? "explain" : undefined;
  if (!operation) return null;
  const text = point ? pointText(previous.content, point) : previous.content.trim();
  if (!text) return null;
  const citationIds = [...new Set(extractCitationIds(text).map(id => id.toLowerCase()))];
  if (!citationIds.length || citationIds.length > 12 || citationIds.some(id => !fullId.test(id) && !shortId.test(id))) return null;
  return { operation, text, citationIds, ...(point ? { point } : {}) };
}

function pointText(text: string, point: number): string | undefined {
  if (text.startsWith(savedTableHeader)) {
    const row = text.split("\n").find(line => line.startsWith(`| ${point} | `));
    return row?.slice(`| ${point} | `.length, -2).replace(/\\\|/g, "|");
  }
  // Respect the visible numbering, including numbered Markdown headings.
  const points = [...text.matchAll(/^(?:#{1,6}\s+)?(\d{1,2})[.)]\s+(.*)$/gm)];
  const index = points.findIndex(match => Number(match[1]) === point);
  if (index !== -1) {
    const match = points[index];
    const end = points[index + 1]?.index ?? text.length;
    return text.slice(match.index! + match[0].length - match[2].length, end).trim();
  }
  const bullets = text.split("\n").filter(line => /^[-*+]\s+/.test(line));
  return bullets[point - 1]?.replace(/^[-*+]\s+/, "").trim();
}

/** The fast follow-up path reuses knowledge documents only. */
export async function loadSavedAnswerSources(
  db: SupabaseClient,
  orgId: string,
  scope: ScopeFilters,
  knowledgeScope: KnowledgeScopeDef,
  citationIds: readonly string[],
  signal: AbortSignal,
  allowPartial = false,
): Promise<SavedAnswerSource[] | null> {
  return loadSources(db, orgId, scope, knowledgeScope, citationIds, signal, { allowPartial });
}

/** A click can resolve a cited scorecard when the current source grant permits it. */
export async function loadSavedCitation(
  db: SupabaseClient, orgId: string, scope: ScopeFilters, id: string, signal: AbortSignal,
): Promise<SavedCitationSource | null> {
  const [source] = await loadSources(db, orgId, scope, knowledgeScopeDef("all"), [id], signal, { preview: true }) ?? [];
  const type = source?.source_type;
  return type === "document" || type === "call_score" ? { ...source, source_type: type } : null;
}

/** A scoped read by full UUID or an unambiguous legacy prefix. */
async function loadSources(
  db: SupabaseClient, orgId: string, scope: ScopeFilters, knowledgeScope: KnowledgeScopeDef,
  citationIds: readonly string[], signal: AbortSignal, options: { allowPartial?: boolean; preview?: boolean },
): Promise<SourceRow[] | null> {
  const types = (options.preview ? ["document", "call_score"] : ["document"])
    .filter(type => !scope.sourceTypes.length || scope.sourceTypes.includes(type));
  if (!types.length) return null;
  let query = db.from("chunks")
    .select(options.preview
      ? "id, document_id, content, intelligence_class, source_type, documents!inner(title, created_at, updated_at, source_type, call_date:metadata->>call_date, call_date_basis:metadata->>call_date_basis, reported_call_date:metadata->>reported_call_date, overall_score:metadata->overall_score, performance_band:metadata->>performance_band)"
      : "id, document_id, content, intelligence_class, documents!inner(title, created_at, updated_at)")
    .eq("org_id", orgId)
    .eq("documents.org_id", orgId);
  query = types.length === 1
    ? query.eq("source_type", types[0]).eq("documents.source_type", types[0])
    : query.in("source_type", types).in("documents.source_type", types);
  if (scope.dataSourceIds.length) query = query.in("data_source_id", scope.dataSourceIds);
  if (scope.collectionIds.length) query = query.overlaps("collection_ids", scope.collectionIds);

  const exact = citationIds.filter(id => fullId.test(id));
  const prefixes = citationIds.filter(id => shortId.test(id));
  if (prefixes.length) {
    const ranges = prefixes.map(prefix => `and(id.gte.${prefix}-0000-0000-0000-000000000000,id.lte.${prefix}-ffff-ffff-ffff-ffffffffffff)`);
    if (exact.length) ranges.push(`id.in.(${exact.join(",")})`);
    query = query.or(ranges.join(","));
  } else {
    query = query.in("id", exact);
  }
  const { data, error } = await query.limit(30).abortSignal(signal);
  if (error || !data || data.length >= 30) return null;
  const rows = data as unknown as SourceRow[];
  const lanes = knowledgeScope.retrieval.lanes;
  const classes = lanes
    ? Object.keys(lanes).flatMap(lane => LANE_CLASS[lane as Lane])
    : [...LANE_CLASS.reality, ...LANE_CLASS.learning, ...LANE_CLASS.playbook, ...LANE_CLASS.platform];
  if (knowledgeScope.retrieval.raw === "always") classes.push("raw_archive");
  const selected = citationIds.map(id => {
    const hits = rows.filter(row => fullId.test(id) ? row.id.toLowerCase() === id : row.id.toLowerCase().startsWith(id + "-"));
    if (hits.length !== 1) return null;
    const hit = hits[0];
    if (!hit.documents || !classes.some(cls => cls === (hit.intelligence_class ?? "business_reality"))) return null;
    if (options.preview && (!hit.source_type || hit.source_type !== hit.documents.source_type || !types.includes(hit.source_type))) return null;
    return hit;
  });
  if (!options.allowPartial && selected.some(row => row === null)) return null;
  return [...new Map(selected.flatMap(row => row ? [[row.id, row] as const] : [])).values()];
}

/** An extractive fallback cannot attach a citation to a claim the model invented. */
export function quoteOriginalSources(sources: readonly SavedAnswerSource[], alreadyCited: readonly string[]): string {
  return sources.filter(source => !alreadyCited.includes(source.id) && !!source.content.trim()).map(source => {
    const text = source.content.trim().replace(/\s+/g, " ");
    const excerpt = text.length > 360 ? text.slice(0, 360).replace(/\s+\S*$/, "") + "…" : text;
    return `> ${excerpt.replace(/[\\\[\]`*_~]/g, "\\$&")} [${source.id}]`;
  }).join("\n\n");
}

const filler = /^(?:here(?:'s| is) (?:a |the )?(?:(?:quick|brief|short) )?(?:summary|overview|breakdown)|in summary|to sum up|let me know if (?:you(?:'d| would) like more detail|you have any questions))[:.!]?$/i;
function shorten(text: string): string | null {
  const result = text.split("\n").filter(line => !filler.test(line.trim())).map(line =>
    line.replace(/^(\s*(?:[-*+] |\d+[.)] )?)(?:the main thing to keep in mind is that |it is important to note that )/i,
      (_, prefix: string) => prefix)
  ).join("\n").trim();
  return result.length < text.length ? result : null;
}

function table(text: string): string | null {
  if (/^\s*(?:```|~~~|\||>|---)/m.test(text)) return null;
  const rows = text.split("\n").map(line => line.trim()).filter(line => line && !filler.test(line));
  if (rows.length < 2 || rows.length > 24) return null;
  let next = 1;
  return [savedTableHeader, ...rows.map(line => {
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) return `| | **${heading[1].replace(/\|/g, "\\|")}** |`;
    const list = /^(?:(\d{1,2})[.)]|[-*+])\s+(.+)$/.exec(line);
    const point = list?.[1] ?? next;
    next = Number(point) + 1;
    return `| ${point} | ${(list?.[2] ?? line).replace(/\|/g, "\\|")} |`;
  })].join("\n");
}

function explain(plan: SavedAnswerPlan, sources: readonly SavedAnswerSource[]): string | null {
  // Quote relevant additional detail from the exact cited passages. A source
  // without an additional relevant sentence falls back to grounded generation.
  const words = (text: string) => text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? [];
  const prior = plan.text.toLowerCase();
  const stop = new Set(["that", "this", "from", "with", "will", "when", "before", "after", "about", "have", "their"]);
  const terms = new Set(words(plan.text.replace(/\[[^\]]+\]/g, "")).filter(word => !stop.has(word)));
  const candidates = sources.flatMap(source => source.content.split(/(?<=[.!?])\s+|\r?\n/).map(sentence => ({
    sentence: sentence.trim(), source,
  }))).filter(({ sentence }) => sentence.length >= 25 && sentence.length <= 420 && !prior.includes(sentence.toLowerCase())
    && !/[|`\[\]<>]/.test(sentence));
  const ranked = candidates.map(item => ({
    ...item, overlap: new Set(words(item.sentence).filter(word => terms.has(word))).size,
  })).sort((a, b) => b.overlap - a.overlap);
  const detail = ranked[0];
  if (!detail || detail.overlap < 2) return null;
  return [
    ...(plan.point ? [`**Point ${plan.point}**`] : []),
    plan.text,
    `**Supporting detail from ${detail.source.documents.title}**\n\n> ${detail.sentence} [${detail.source.id}]`,
  ].join("\n\n");
}

export function renderSavedAnswer(plan: SavedAnswerPlan, sources: readonly SavedAnswerSource[]): string | null {
  if (plan.operation === "table") return table(plan.text);
  if (plan.operation === "shorten") return shorten(plan.text);
  return explain(plan, sources);
}
