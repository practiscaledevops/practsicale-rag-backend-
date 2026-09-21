// Web page → text. Fetches a public URL (SSRF-guarded, 15 s, 2 MB), keeps the
// readable region (<article> → <main> → <body>), strips chrome and scripts,
// decodes entities and collapses whitespace. The title comes from og:title or
// <title>; the platform from the hostname so the wizard can pre-fill provenance.
//
// Login-walled pages (LinkedIn, Instagram) render a near-empty shell to a
// server — under 200 usable characters we say so instead of ingesting noise.

import { guardedFetch } from "./fetch";
import { extractPdf } from "./pdf";
import { ExtractError, type Extracted } from "./types";

const MIN_USABLE_CHARS = 200;
export const LOGIN_WALL_MESSAGE = "This page doesn't expose its text (login wall). Paste the transcript or caption instead.";
const SOCIAL_PLATFORMS = new Set(["linkedin", "instagram", "facebook", "x", "tiktok"]);

// ---- pure helpers (unit-tested; no network) --------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  laquo: "«", raquo: "»", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™", times: "×", deg: "°", euro: "€", pound: "£",
};

/** Decode numeric (&#39; &#x27;) and the common named HTML entities. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}
function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

/** Collapse runs of spaces, trim every line, and keep at most one blank line. */
export function collapseWhitespace(s: string): string {
  return s
    .replace(/\r/g, "")
    .replace(/[ \t  -​ 　]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const DROP_TAGS = ["script", "style", "noscript", "template", "svg", "iframe", "canvas", "nav", "header", "footer", "aside", "form"];
const BLOCK_TAGS = ["p", "div", "section", "article", "main", "blockquote", "pre", "ul", "ol", "table", "thead", "tbody", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "dl", "dt", "dd", "figure", "figcaption", "address"];

// Linear scans only: `<tag>[\s\S]*?</tag>` regexes over attacker-controlled
// HTML go quadratic on unclosed tags (a 2 MB page of `<script>` openers would
// pin the function), and this runs for any spoke user via /api/v1/extract.
const MAX_TAGS = 60_000;

/** The largest `<tag>…</tag>` region: from the first opener to the last closer (no nesting needed for article/main). */
function region(html: string, tag: string): string | null {
  const lower = html.toLowerCase();
  const openAt = lower.indexOf(`<${tag}`);
  if (openAt < 0) return null;
  const openEnd = lower.indexOf(">", openAt);
  const closeAt = lower.lastIndexOf(`</${tag}`);
  if (openEnd < 0 || closeAt <= openEnd) return null;
  return html.slice(openEnd + 1, closeAt);
}

/** Remove comments and the contents of DROP_TAGS in one pass over the tags. */
function dropNoise(html: string): string {
  const out: string[] = [];
  const drop = new Set(DROP_TAGS);
  let depthTag: string | null = null;
  let depth = 0;
  let i = 0;
  let tags = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      if (!depthTag) out.push(html.slice(i));
      break;
    }
    if (!depthTag) out.push(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt);
    if (gt < 0) break;
    if (++tags > MAX_TAGS) break;
    const raw = html.slice(lt + 1, gt);
    const m = /^(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(raw);
    const name = m?.[2]?.toLowerCase() ?? "";
    const closing = m?.[1] === "/";
    if (depthTag) {
      if (name === depthTag) {
        if (closing) depth--;
        else if (!raw.endsWith("/")) depth++;
        if (depth === 0) depthTag = null;
      }
    } else if (drop.has(name) && !closing && !raw.endsWith("/")) {
      depthTag = name;
      depth = 1;
      out.push(" ");
    } else {
      out.push(html.slice(lt, gt + 1));
    }
    i = gt + 1;
  }
  return out.join("");
}

/** Strip an HTML fragment down to readable text (block tags → line breaks, lists → "- "). */
export function stripHtml(fragment: string): string {
  let s = dropNoise(fragment);
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<\/(td|th)\s*>/gi, " \t");
  s = s.replace(new RegExp(`<\\/?(${BLOCK_TAGS.join("|")})\\b[^>]*>`, "gi"), "\n");
  s = s.replace(/<[^>]+>/g, " ");
  return collapseWhitespace(decodeEntities(s));
}

/**
 * The readable text of a whole HTML document: the longest <article>, else
 * <main>, else <body>, else everything — falling through when a region turns
 * out to be a stub (a page can have a tiny <article> card and the real content
 * in <main>).
 */
export function htmlToText(html: string): string {
  const candidates = [region(html, "article"), region(html, "main"), region(html, "body"), html];
  let longest = "";
  for (const c of candidates) {
    if (c == null) continue;
    const text = stripHtml(c);
    if (text.length >= MIN_USABLE_CHARS) return text;
    if (text.length > longest.length) longest = text;
  }
  return longest;
}

/** og:title → <title> (entity-decoded, whitespace-collapsed), or null. */
export function htmlTitle(html: string): string | null {
  const og =
    html.match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
    html.match(/<meta\b[^>]*content=["']([^"']*)["'][^>]*property=["']og:title["']/i)?.[1];
  const raw = og || html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || "";
  const t = collapseWhitespace(decodeEntities(raw)).replace(/\s*\n\s*/g, " ");
  return t ? t.slice(0, 200) : null;
}

/** Taxonomy platform for a hostname (linkedin · instagram · x · facebook · tiktok · youtube · podcast · website). */
export function platformOfHost(hostname: string): string {
  const h = hostname.toLowerCase().replace(/^www\./, "");
  const is = (d: string) => h === d || h.endsWith(`.${d}`);
  if (is("linkedin.com") || is("lnkd.in")) return "linkedin";
  if (is("instagram.com")) return "instagram";
  if (is("x.com") || is("twitter.com") || is("t.co")) return "x";
  if (is("facebook.com") || is("fb.com") || is("fb.watch")) return "facebook";
  if (is("tiktok.com")) return "tiktok";
  if (is("youtube.com") || is("youtu.be")) return "youtube";
  if (
    h.startsWith("podcasts.") || h.includes("podcast") || is("spotify.com") || is("anchor.fm") || is("podbean.com") ||
    is("buzzsprout.com") || is("transistor.fm") || is("simplecast.com") || is("libsyn.com") || is("castbox.fm")
  ) return "podcast";
  return "website";
}

// ---- the adapter -----------------------------------------------------------

export async function extractFromUrl(url: string): Promise<Extracted> {
  const clean = url.trim();
  if (!/^https?:\/\//i.test(clean)) throw new ExtractError("Enter a full link starting with http:// or https://.", 400);

  const res = await guardedFetch(clean, { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 });
  const platform = platformOfHost(new URL(res.finalUrl).hostname);
  if (res.status >= 400) {
    // Social platforms answer a server with 401/403/429/999 or a login redirect — never the post.
    if (SOCIAL_PLATFORMS.has(platform) || res.status === 401 || res.status === 403 || res.status === 999) throw new ExtractError(LOGIN_WALL_MESSAGE, 422);
    if (res.status === 404) throw new ExtractError("The link returned 404 — check the URL.", 422);
    throw new ExtractError(`The link returned HTTP ${res.status}.`, 502);
  }
  const base = { source_platform: platform, source_url: res.finalUrl };

  // A link straight to a PDF or a plain-text file: hand it to the right decoder.
  if (res.contentType.includes("application/pdf") || res.body.subarray(0, 5).toString("latin1") === "%PDF-") {
    if (res.truncated) throw new ExtractError("This PDF is larger than the link limit (2 MB). Download it and upload it instead.", 413);
    const pdf = await extractPdf(res.body);
    return { ...pdf, meta: { ...pdf.meta, ...base } };
  }
  if (res.contentType.startsWith("text/plain")) {
    const text = collapseWhitespace(res.text);
    if (text.length < MIN_USABLE_CHARS) throw new ExtractError(LOGIN_WALL_MESSAGE, 422);
    return { text, meta: { source_type: "text", ...base } };
  }
  // Anything else must be an HTML page — binary bodies decoded as UTF-8 would
  // "extract" as garbage that easily clears the minimum length.
  const ct = res.contentType.split(";")[0].trim();
  if (ct && !ct.startsWith("text/html") && !ct.startsWith("application/xhtml") && !ct.startsWith("application/xml") && !ct.startsWith("text/xml")) {
    throw new ExtractError(`The link is a ${ct} file, not a page. Download it and upload it instead.`, 415);
  }

  const title = htmlTitle(res.text);
  const body = htmlToText(res.text);
  if (body.length < MIN_USABLE_CHARS) throw new ExtractError(LOGIN_WALL_MESSAGE, 422);

  return {
    text: title ? `# ${title}\n\n${body}` : body,
    title: title ?? undefined,
    meta: { source_type: "text", ...base },
  };
}
