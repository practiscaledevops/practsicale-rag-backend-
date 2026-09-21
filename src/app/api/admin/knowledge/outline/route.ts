// POST /api/admin/knowledge/outline — which heading-like lines of a long source start a chapter?
//
// The wizard finds the heading candidates IN THE BROWSER and sends only that
// short list (never the megabytes of text); one model call on
// settings.intelligence.classifyTier picks the top-level units and reads the
// work's title/author. The browser then does the split itself
// (src/lib/long-source-pure.ts). Candidate lines are data from an uploaded
// file — never instructions.
//
// Accepts JSON { candidates: [{ index, text, hint? }] (≤ 600, each string ≤ 200 chars), title? }.
// Returns { title, author, chapters: [{ index, title }], via: "model" | "fallback", model }.
//   via "fallback" (model unavailable / < 3 chapters found) → chapters is empty and the
//   browser splits by size instead.
// org_id is resolved server-side; needs the documents:write grant.

import { supabaseAdmin } from "@/lib/supabase";
import { loadSettings } from "@/lib/settings";
import { outlineLongSource } from "@/lib/long-source";
import { MAX_OUTLINE_CANDIDATES, MAX_CANDIDATE_CHARS, type OutlineCandidate } from "@/lib/long-source-pure";
import { guard, str } from "../_shared";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 120;

export async function POST(req: Request) {
  const g = await guard("documents:write");
  if ("response" in g) return g.response;
  const { admin } = g;

  const body = (await req.json().catch(() => null)) as { candidates?: unknown; title?: unknown } | null;
  if (!body || !Array.isArray(body.candidates)) return Response.json({ error: "candidates (array) is required." }, { status: 400 });
  if (body.candidates.length > MAX_OUTLINE_CANDIDATES) return Response.json({ error: `Too many candidates (max ${MAX_OUTLINE_CANDIDATES}).` }, { status: 413 });

  const candidates: OutlineCandidate[] = [];
  const seen = new Set<number>();
  for (const raw of body.candidates as Record<string, unknown>[]) {
    const index = typeof raw?.index === "number" && Number.isInteger(raw.index) && raw.index >= 0 ? raw.index : -1;
    const text = typeof raw?.text === "string" ? raw.text : "";
    const hint = typeof raw?.hint === "string" ? raw.hint : "";
    if (index < 0 || seen.has(index) || !text.trim()) return Response.json({ error: "Each candidate needs a unique non-negative integer `index` and a `text`." }, { status: 400 });
    if (text.length > MAX_CANDIDATE_CHARS || hint.length > MAX_CANDIDATE_CHARS) return Response.json({ error: `Candidate text and hint are limited to ${MAX_CANDIDATE_CHARS} characters.` }, { status: 413 });
    seen.add(index);
    // One line each: a line break inside a candidate could forge another row of the list.
    candidates.push({ index, text: text.replace(/\s+/g, " ").trim(), hint: hint.replace(/\s+/g, " ").trim() });
  }

  const { settings } = await loadSettings(admin.orgId, supabaseAdmin());
  const result = await outlineLongSource({ candidates, title: str(body.title, 200) || null, tier: settings.intelligence.classifyTier });
  return Response.json(result);
}
