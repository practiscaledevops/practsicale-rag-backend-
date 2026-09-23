// Fathom call recording → timestamped transcript. No API key.
//
// A Fathom share link (fathom.video/share/<shareId>) is token-authed, not
// IP-gated, so this works from a datacenter (Vercel) where the browser paths
// get bot-walled. Two hops:
//
//   1. GET the share page → its embedded config carries the numeric call id
//      (`"call":{"id":<digits>`) and the recording's title (og:title).
//   2. GET https://fathom.video/calls/<callId>/copy_transcript?token=<shareId>
//      → 200 JSON `{ "html": "<h1>…</h1><p><a>@0:17</a> - <b>Speaker</b></p>…" }`.
//      The ?token= is the share id and is required (401 without it).
//
// The transcript HTML is converted to `mm:ss - Speaker\n  text` turns. Both
// fetches go through guardedFetch, so the SSRF guard runs on the URL and every
// redirect hop, with bounded bodies and timeouts.

import { guardedFetch, BROWSER_UA } from "./fetch";
import { decodeEntities, collapseWhitespace, htmlTitle } from "./url";
import { ExtractError, type Extracted } from "./types";

const FATHOM_FALLBACK =
  "This Fathom recording isn't shared publicly or its transcript isn't ready. Open the share link's ⋯ menu → Copy Transcript and paste it, or make the share public.";

// ---- pure helpers (unit-tested; no network) --------------------------------

/** `{ shareId }` for a fathom.video share/calls link, else null. */
export function parseFathomUrl(url: string): { shareId: string } | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.hostname.toLowerCase().replace(/^www\./, "") !== "fathom.video") return null;
  const share = u.pathname.match(/^\/share\/([A-Za-z0-9_-]+)/);
  if (share) return { shareId: share[1] };
  const calls = u.pathname.match(/^\/calls\/([A-Za-z0-9_-]+)/);
  if (calls) {
    // A shared /calls/ link carries the share token in the query; without one
    // the path id is all we have (and /share/<id> will 404 → clean fallback).
    const token = u.searchParams.get("share") ?? u.searchParams.get("token");
    return { shareId: token && /^[A-Za-z0-9_-]+$/.test(token) ? token : calls[1] };
  }
  return null;
}

const MONTHS: Record<string, string> = {
  jan: "January", feb: "February", mar: "March", apr: "April", may: "May", jun: "June",
  jul: "July", aug: "August", sep: "September", sept: "September", oct: "October", nov: "November", dec: "December",
};

/** "Sep 22" → "September 22" (only when a day number follows, so prose is left alone). */
function expandMonths(s: string): string {
  return s.replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\.?(?=\s+\d)/gi, (m, mon: string) => MONTHS[mon.toLowerCase()] ?? m);
}

/** Tag-strip → entity-decode → collapse a small HTML fragment (a heading, a speaker, a line). */
function clean(fragment: string): string {
  return collapseWhitespace(decodeEntities(fragment.replace(/<[^>]+>/g, " ")));
}

/** Speaker name from a `<b>` label, dropping a trailing "(email@…)" parenthetical (PII, and noise). */
function cleanSpeaker(raw: string): string {
  return clean(raw).trim().replace(/\s*\([^)]*@[^)]*\)\s*$/, "").trim();
}

/** JSON string-body → its decoded value (`\n`, `\"`, `\uXXXX`, `\/`). */
function jsonUnescape(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\//g, "/").replace(/\\\\/g, "\\");
  }
}

/** The recording title from the config's `"title":"…"`, else null. */
export function parseFathomTitle(decodedHtml: string): string | null {
  const raw = decodedHtml.match(/"title":"((?:[^"\\]|\\.)*)"/)?.[1];
  if (!raw) return null;
  return jsonUnescape(raw).trim() || null;
}

/** Approximate duration from the largest `timestamp=<seconds>` anchor in the transcript, else undefined. */
export function parseFathomDuration(transcriptHtml: string): number | undefined {
  let max = 0;
  for (const m of transcriptHtml.matchAll(/[?&]timestamp=(\d+(?:\.\d+)?)/g)) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max > 0 ? Math.round(max) : undefined;
}

/**
 * Fathom's copy_transcript HTML → a clean transcript. Each speaker turn is a
 * `<p>` with an `@m:ss` anchor and a `<b>` speaker, followed by `<p>` bodies;
 * the leading `<h1>` becomes the title line (month abbreviations expanded).
 */
export function fathomHtmlToTranscript(html: string): { title: string | null; text: string } {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const title = h1 ? expandMonths(clean(h1)).trim() || null : null;

  const turns: string[] = [];
  let header: string | null = null;
  let words: string[] = [];
  const flush = () => {
    if (header !== null) {
      const body = collapseWhitespace(words.join(" ")).trim();
      turns.push(body ? `${header}\n  ${body}` : header);
    }
    header = null;
    words = [];
  };

  for (const m of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const inner = m[1];
    const ts = inner.match(/<a\b[^>]*>\s*@?\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*<\/a>/i)?.[1];
    const speaker = inner.match(/<b\b[^>]*>([\s\S]*?)<\/b>/i)?.[1];
    if (ts && speaker != null) {
      flush();
      header = `${ts} - ${cleanSpeaker(speaker)}`;
    } else {
      const t = clean(inner).trim();
      if (t) words.push(t);
    }
  }
  flush();

  const body = turns.join("\n\n");
  return { title, text: title ? `${title}\n\n${body}` : body };
}

// ---- the adapter -----------------------------------------------------------

export async function extractFathom(url: string): Promise<Extracted> {
  const parsed = parseFathomUrl(url);
  if (!parsed) throw new ExtractError("That doesn't look like a Fathom share link (fathom.video/share/… or /calls/…).", 400);
  const { shareId } = parsed;
  const shareUrl = `https://fathom.video/share/${encodeURIComponent(shareId)}`;

  // 1. Share page: SSRF-guarded, browser UA (the config is only served to a browser).
  const page = await guardedFetch(shareUrl, { timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024, headers: { "user-agent": BROWSER_UA } });
  if (page.status >= 400) throw new ExtractError(FATHOM_FALLBACK, 422);

  // 2. Entity-decode so the config (stored HTML-escaped in the page) is matchable.
  const decoded = page.text.replace(/&quot;/g, '"');
  const callId = decoded.match(/"call":\{"id":(\d+)/)?.[1] ?? decoded.match(/\bcall-(\d+)/)?.[1];
  if (!callId) throw new ExtractError(FATHOM_FALLBACK, 422);

  // 3. Transcript endpoint: token-auth (the share id), returns 200 JSON `{ html }`.
  const transcriptUrl = `https://fathom.video/calls/${callId}/copy_transcript?token=${encodeURIComponent(shareId)}`;
  const tr = await guardedFetch(transcriptUrl, {
    timeoutMs: 20_000,
    maxBytes: 12 * 1024 * 1024,
    headers: { "user-agent": BROWSER_UA, accept: "application/json, text/plain, */*", referer: shareUrl },
  });
  if (tr.status >= 400) throw new ExtractError(FATHOM_FALLBACK, 422);

  let payload: { html?: unknown };
  try {
    payload = JSON.parse(tr.text) as { html?: unknown };
  } catch {
    throw new ExtractError(FATHOM_FALLBACK, 422);
  }
  const transcriptHtml = typeof payload.html === "string" ? payload.html : "";
  if (!transcriptHtml.trim()) throw new ExtractError(FATHOM_FALLBACK, 422);

  // 4. HTML → clean timestamped transcript.
  const { title: h1Title, text: transcript } = fathomHtmlToTranscript(transcriptHtml);
  if (!transcript.trim()) throw new ExtractError(FATHOM_FALLBACK, 422);

  // 5. Prefer the share page's og:title / config title (cleaner than the dated <h1>).
  const title = (htmlTitle(page.text) || parseFathomTitle(decoded) || h1Title || "").trim() || undefined;
  const meta: Extracted["meta"] = { source_type: "call", source_platform: "fathom", source_url: url };
  const duration = parseFathomDuration(transcriptHtml);
  if (duration) meta.duration_s = duration;

  return { text: transcript, title, meta };
}
