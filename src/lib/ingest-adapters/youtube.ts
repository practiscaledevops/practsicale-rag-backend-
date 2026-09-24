// YouTube video → transcript text. Two paths:
//
// NATIVE (free, no key): the caption tracks come from YouTube's own player
// endpoint (innertube, the ANDROID → IOS → TVHTML5 clients): the web watch page
// also lists them, but since 2025 the web client's timedtext URLs answer an
// empty 200 to anything without a browser "pot" token, while the app clients'
// URLs still serve the captions. The watch page stays as the fallback for the
// details and tracks. We fetch the English (or auto) track as json3 (srv3/XML
// fallback), join it into readable paragraphs and put the title/author (oEmbed)
// on top. Without captions we return the title + description, flagged.
//
// EXA (paid, ~$0.001, key via getProviderKey("exa") — see ./exa): YouTube
// bot-walls datacenter IPs ("sign in to confirm you're not a bot"), so on
// Vercel the native chain fails. Measured from a residential IP: native
// 0.65–0.85 s, Exa 0.4–1.4 s. So: on Vercel Exa goes FIRST (native is the
// fallback); elsewhere native goes first (free, faster) and Exa takes over
// when it throws (bot wall, no captions/description, network) or finds no
// captions. Without an Exa key the native chain is the only path, as before.

import { guardedFetch, BROWSER_UA } from "./fetch";
import { decodeEntities, collapseWhitespace } from "./url";
import { parseYouTubeId } from "./pure";
import { tryExaContents } from "./exa";
import { ExtractError, type Extracted } from "./types";

// ---- pure helpers (unit-tested; no network) --------------------------------

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  /** "asr" = auto-generated. */
  kind?: string;
  name?: string;
}

export interface CaptionSegment {
  /** start, ms */
  t: number;
  /** duration, ms */
  d: number;
  text: string;
}

export interface VideoDetails {
  title?: string;
  author?: string;
  description?: string;
  lengthSeconds?: number;
}

/**
 * The JSON value (object or array) that starts at `start` in `src`, found by
 * bracket balancing that respects strings — the player JSON is embedded in a
 * <script> so a non-greedy regex would stop at the first "]" inside a string.
 */
export function readJsonValue(src: string, start: number): string | null {
  const open = src[start];
  if (open !== "[" && open !== "{") return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function jsonAfter(src: string, key: string): unknown {
  const idx = src.indexOf(key);
  if (idx < 0) return undefined;
  const raw = readJsonValue(src, idx + key.length);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Normalise a `captionTracks` array (from the page or the player API). */
export function normalizeCaptionTracks(v: unknown): CaptionTrack[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => ({
      baseUrl: typeof t.baseUrl === "string" ? t.baseUrl : "",
      languageCode: typeof t.languageCode === "string" ? t.languageCode : "",
      kind: typeof t.kind === "string" ? t.kind : undefined,
      name: t.name && typeof t.name === "object" ? String((t.name as { simpleText?: string; runs?: { text?: string }[] }).simpleText ?? (t.name as { runs?: { text?: string }[] }).runs?.[0]?.text ?? "") : undefined,
    }))
    .filter((t) => t.baseUrl);
}

/** The caption tracks embedded in a watch page (`"captionTracks":[…]`), or []. */
export function parseCaptionTracks(html: string): CaptionTrack[] {
  return normalizeCaptionTracks(jsonAfter(html, '"captionTracks":'));
}

/** Prefer a human English track, then auto-generated English, then any human track, then the first. */
export function pickCaptionTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  if (!tracks.length) return null;
  const en = (t: CaptionTrack) => t.languageCode.toLowerCase().startsWith("en");
  const human = (t: CaptionTrack) => t.kind !== "asr";
  return tracks.find((t) => en(t) && human(t)) ?? tracks.find(en) ?? tracks.find(human) ?? tracks[0];
}

/** Normalise a `videoDetails` object (from the page or the player API). */
export function normalizeVideoDetails(d: unknown): VideoDetails {
  const out: VideoDetails = {};
  if (!d || typeof d !== "object") return out;
  const o = d as Record<string, unknown>;
  if (typeof o.title === "string" && o.title.trim()) out.title = o.title.trim();
  if (typeof o.author === "string" && o.author.trim()) out.author = o.author.trim();
  if (typeof o.shortDescription === "string") out.description = o.shortDescription;
  const n = Number(o.lengthSeconds);
  if (Number.isFinite(n) && n > 0) out.lengthSeconds = n;
  return out;
}

/** title / author / shortDescription / lengthSeconds from the page's `videoDetails`. */
export function parseVideoDetails(html: string): VideoDetails {
  const out = normalizeVideoDetails(jsonAfter(html, '"videoDetails":'));
  if (!out.title) {
    const t = html.match(/<meta\b[^>]*name=["']title["'][^>]*content=["']([^"']*)["']/i)?.[1];
    if (t) out.title = decodeEntities(t);
  }
  return out;
}

/** Segments from the json3 caption format (`events[].segs[].utf8`). */
export function parseJson3(raw: string): CaptionSegment[] {
  let json: { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }[] };
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: CaptionSegment[] = [];
  for (const ev of json.events ?? []) {
    if (!ev.segs?.length) continue;
    const text = ev.segs.map((s) => s.utf8 ?? "").join("");
    if (!text.trim()) continue;
    out.push({ t: Number(ev.tStartMs) || 0, d: Number(ev.dDurationMs) || 0, text });
  }
  return out;
}

/**
 * Segments from the XML caption formats: legacy `<text start="1.2" dur="3.4">`
 * (seconds, double-encoded entities) and srv3 `<p t="1200" d="3400">` (ms,
 * optional `<s>` word children).
 */
export function parseTimedTextXml(raw: string): CaptionSegment[] {
  const out: CaptionSegment[] = [];
  for (const m of raw.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)) {
    const attrs = m[1];
    const start = Number(attrs.match(/start="([\d.]+)"/)?.[1] ?? 0);
    const dur = Number(attrs.match(/dur="([\d.]+)"/)?.[1] ?? 0);
    const text = decodeEntities(decodeEntities(m[2])).replace(/<[^>]+>/g, "");
    if (!text.trim()) continue;
    out.push({ t: Math.round(start * 1000), d: Math.round(dur * 1000), text });
  }
  if (out.length) return out;
  for (const m of raw.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
    const attrs = m[1];
    const t = Number(attrs.match(/\bt="(\d+)"/)?.[1] ?? 0);
    const d = Number(attrs.match(/\bd="(\d+)"/)?.[1] ?? 0);
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ""));
    if (!text.trim()) continue;
    out.push({ t, d, text });
  }
  return out;
}

/** Segments from whichever caption format came back (json3 or XML). */
export function parseTimedText(raw: string): CaptionSegment[] {
  const s = raw.trimStart();
  if (!s) return [];
  return s.startsWith("{") ? parseJson3(s) : parseTimedTextXml(s);
}

/**
 * Join caption segments into paragraphs: break on a pause of 4 s or more, or
 * once a paragraph passes ~600 characters and ends a sentence.
 */
export function segmentsToParagraphs(segs: CaptionSegment[]): string {
  const paras: string[] = [];
  let cur = "";
  let lastEnd = 0;
  for (const s of segs) {
    const txt = s.text.replace(/\s+/g, " ").trim();
    if (!txt) continue;
    const gap = s.t - lastEnd;
    if (cur && (gap >= 4000 || (cur.length > 600 && /[.!?]["')\]]?$/.test(cur)))) {
      paras.push(cur);
      cur = "";
    }
    cur = cur ? `${cur} ${txt}` : txt;
    lastEnd = s.t + s.d;
  }
  if (cur) paras.push(cur);
  return paras.join("\n\n");
}

/**
 * Break a transcript that arrives as one unbroken block (Exa's shape) into the
 * native path's paragraphs: a break once a paragraph passes `target` characters
 * and ends a sentence, or at twice `target` for unpunctuated auto-captions.
 * Text that already has blank-line paragraphs is returned as is.
 */
export function blockToParagraphs(text: string, target = 600): string {
  const t = text.replace(/\r\n?/g, "\n").trim();
  if (/\n[ \t]*\n/.test(t)) return t;
  const paras: string[] = [];
  let cur = "";
  for (const w of t.split(/\s+/)) {
    if (!w) continue;
    cur = cur ? `${cur} ${w}` : w;
    if ((cur.length >= target && /[.!?]["')\]]?$/.test(w)) || cur.length >= target * 2) {
      paras.push(cur);
      cur = "";
    }
  }
  if (cur) paras.push(cur);
  return paras.join("\n\n");
}

// A short line of YouTube's own page chrome in an Exa read: the "<title> - YouTube"
// line, the footer ("About Press Copyright …"), the bot-wall prompt. A stale Exa
// cache entry of a watch page can hold only these (seen live: 211 chars, no transcript).
const YT_CHROME_LINE = /\s-\sYouTube$|About Press Copyright|Privacy Policy & Safety|How YouTube works|sign in to confirm|not a bot/i;
const YT_CHROME_MAX_LINE = 300;

/** The spoken text of Exa's read of a watch page: short YouTube chrome lines dropped (a transcript arrives as one long line). */
export function exaYouTubeTranscript(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => !(l.trim().length < YT_CHROME_MAX_LINE && YT_CHROME_LINE.test(l.trim())))
    .join("\n")
    .trim();
}

/** Vercel functions run on datacenter IPs that YouTube bot-walls, so Exa goes first there. */
export function youTubeExaFirst(): boolean {
  return Boolean(process.env.VERCEL || process.env.VERCEL_REGION);
}

function fmtDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

// ---- network ---------------------------------------------------------------

const PAGE_HEADERS = {
  "user-agent": BROWSER_UA,
  // Skip the EU consent interstitial, which otherwise replaces the watch page.
  cookie: "CONSENT=YES+cb.20240101-00-p0.en+FX+000; SOCS=CAI",
};

// The datacenter bot wall lands on the ANDROID client, so we try several
// innertube clients in order and stop at the first whose caption track URL
// actually serves a body; the watch page is the last resort.
interface InnertubeClient {
  key: string;
  client: Record<string, unknown>;
  ua: string;
  clientNameHeader: string;
}
const INNERTUBE_CLIENTS: InnertubeClient[] = [
  {
    key: "ANDROID",
    client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "en", gl: "US" },
    ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
    clientNameHeader: "3",
  },
  {
    key: "IOS",
    client: { clientName: "IOS", clientVersion: "20.10.6", hl: "en", gl: "US" },
    ua: "com.google.ios.youtube/20.10.6 (iPhone; U; CPU iOS 18_3 like Mac OS X)",
    clientNameHeader: "5",
  },
  {
    key: "TVHTML5",
    client: { clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER", clientVersion: "2.0", hl: "en", gl: "US" },
    ua: BROWSER_UA,
    clientNameHeader: "85",
  },
];

interface PlayerInfo {
  details: VideoDetails;
  tracks: CaptionTrack[];
  status?: string;
  reason?: string;
}

/** YouTube's player endpoint as one innertube client: details + caption tracks. */
async function fetchPlayer(id: string, c: InnertubeClient): Promise<PlayerInfo | null> {
  try {
    const r = await guardedFetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      timeoutMs: 15_000,
      maxBytes: 4 * 1024 * 1024,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": c.ua,
        "x-youtube-client-name": c.clientNameHeader,
        "x-youtube-client-version": String(c.client.clientVersion),
      },
      body: JSON.stringify({ context: { client: c.client }, videoId: id, contentCheckOk: true, racyCheckOk: true }),
    });
    if (r.status !== 200) return null;
    const j = JSON.parse(r.text) as {
      playabilityStatus?: { status?: string; reason?: string };
      videoDetails?: unknown;
      captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: unknown } };
    };
    return {
      details: normalizeVideoDetails(j.videoDetails),
      tracks: normalizeCaptionTracks(j.captions?.playerCaptionsTracklistRenderer?.captionTracks),
      status: j.playabilityStatus?.status,
      reason: j.playabilityStatus?.reason,
    };
  } catch {
    return null; // the next client / the watch page is the fallback
  }
}

/**
 * The watch page: details + tracks (+ playability). Unlike a hard fetch, this
 * never throws — a bot-walled 429/403 or a network error returns `ok: false`
 * so the caller can still fall back to the innertube details or a clear
 * "paste the transcript" message.
 */
async function fetchWatchPage(watchUrl: string): Promise<PlayerInfo & { ok: boolean }> {
  try {
    const page = await guardedFetch(watchUrl, { timeoutMs: 15_000, maxBytes: 6 * 1024 * 1024, headers: PAGE_HEADERS });
    if (page.status >= 400) return { details: {}, tracks: [], ok: false, reason: `HTTP ${page.status}` };
    const html = page.text;
    const status = html.match(/"playabilityStatus":\{"status":"(\w+)"/)?.[1];
    const reason = html.match(/"playabilityStatus":\{[^}]*?"reason":"((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\"/g, '"');
    return { details: parseVideoDetails(html), tracks: parseCaptionTracks(html), status, reason, ok: true };
  } catch {
    return { details: {}, tracks: [], ok: false };
  }
}

async function fetchOEmbed(watchUrl: string): Promise<{ title?: string; author?: string }> {
  try {
    const r = await guardedFetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`, { timeoutMs: 8_000, maxBytes: 64 * 1024 });
    if (r.status !== 200) return {};
    const j = JSON.parse(r.text) as { title?: string; author_name?: string };
    return { title: typeof j.title === "string" ? j.title : undefined, author: typeof j.author_name === "string" ? j.author_name : undefined };
  } catch {
    return {}; // the player's videoDetails is the fallback
  }
}

/** json3 first (fmt set on the URL so it overrides the track's own), then whatever the bare URL serves. */
async function fetchTranscript(track: CaptionTrack, ua: string): Promise<CaptionSegment[]> {
  let u: URL;
  try {
    u = new URL(track.baseUrl);
  } catch {
    return [];
  }
  const host = u.hostname.toLowerCase();
  if (!(host === "youtube.com" || host.endsWith(".youtube.com"))) return [];
  const json3 = new URL(u);
  json3.searchParams.set("fmt", "json3");
  for (const variant of [json3.toString(), u.toString()]) {
    try {
      // Fetch the timedtext URL with the same client UA that listed the track.
      const r = await guardedFetch(variant, { timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024, headers: { "user-agent": ua, accept: "*/*" } });
      if (r.status === 200) {
        const segs = parseTimedText(r.text);
        if (segs.length) return segs;
      }
    } catch {
      /* try the next variant */
    }
  }
  return [];
}

const YT_BOT_WALL =
  "YouTube is blocking automated transcript access for this video from our servers. Open the video → ⋯ (More) → Show transcript → copy it and paste it here, or download the video and upload the file.";

/** A playability reason that is the bot wall itself (as opposed to private / removed / members-only). */
function isBotReason(reason: string): boolean {
  return /sign in|not a bot|not a robot|confirm you|unusual traffic/i.test(reason);
}

/** Less spoken text than this from Exa is not a transcript (a stale cache entry holds only page chrome). */
const MIN_EXA_TRANSCRIPT_CHARS = 100;

/** Leading characters compared to tell Exa's text apart from the description we already have. */
const OVERLAP_PROBE = 160;

/** YouTube caps a video description at 5,000 characters: a longer Exa read cannot be the description alone. */
const YT_DESCRIPTION_MAX_CHARS = 5000;

const EXA_TRANSCRIPT_HEADER = "Transcript (via Exa):";
const EXA_UNVERIFIED_HEADER = "Text from the video page (via Exa; may be the description, not a transcript):";

/** True when Exa's (whitespace-flattened) text is just the video description we already have. */
function isJustDescription(flat: string, description: string): boolean {
  const d = collapseWhitespace(description).replace(/\s+/g, " ");
  return !!d && (d.includes(flat.slice(0, OVERLAP_PROBE)) || flat.startsWith(d.slice(0, OVERLAP_PROBE)));
}

/**
 * The video through Exa, shaped like the native result (title / byline /
 * "Transcript …" header, paragraphs). null when Exa has no key, fails, reads
 * only page chrome, or returns nothing better than `description` (which the
 * caller already has). livecrawl "preferred": Exa's cache can hold a stale
 * chrome-only copy of a watch page (seen live) while a fresh crawl carries the
 * transcript, so crawl fresh and use the cache only if that crawl fails.
 * Without a description to compare against, a caption-less video's Exa read
 * may BE the description, so it is only labelled a transcript when it is longer
 * than any description can be; otherwise the header says what it might be.
 */
async function extractViaExa(id: string, watchUrl: string, description = ""): Promise<Extracted | null> {
  const page = await tryExaContents(watchUrl, "youtube", { livecrawl: "preferred" });
  if (!page) return null;
  const speech = exaYouTubeTranscript(page.text);
  const flat = speech.replace(/\s+/g, " ");
  if (flat.length < MIN_EXA_TRANSCRIPT_CHARS) return null;
  const descriptionKnown = collapseWhitespace(description) !== "";
  if (descriptionKnown && isJustDescription(flat, description)) return null;

  const title = (page.title ?? "").replace(/\s+-\s+YouTube$/i, "").trim() || `YouTube video ${id}`;
  const author = (page.author ?? "").trim();
  const byline = [author ? `by ${author}` : "", "YouTube"].filter(Boolean).join(" · ");
  const meta: Extracted["meta"] = { source_type: "video", source_platform: "youtube", source_url: watchUrl };
  const header = descriptionKnown || flat.length > YT_DESCRIPTION_MAX_CHARS ? EXA_TRANSCRIPT_HEADER : EXA_UNVERIFIED_HEADER;
  return { text: `# ${title}\n${byline}\n${header}\n\n${blockToParagraphs(speech)}`, title, meta };
}

export async function extractFromYouTube(url: string): Promise<Extracted> {
  const id = parseYouTubeId(url);
  if (!id) throw new ExtractError("That doesn't look like a YouTube video link (watch?v=…, youtu.be/… or /shorts/…).", 400);
  const watchUrl = `https://www.youtube.com/watch?v=${id}`;

  if (youTubeExaFirst()) {
    const viaExa = await extractViaExa(id, watchUrl);
    if (viaExa) return viaExa;
    return (await extractNative(id, watchUrl)).result;
  }

  let native: NativeOutcome;
  try {
    native = await extractNative(id, watchUrl);
  } catch (e) {
    // Bot wall, nothing to read, a refused video, a network failure: Exa reads
    // it from its own crawler. If it can't either, the native message stands.
    const viaExa = await extractViaExa(id, watchUrl);
    if (viaExa) return viaExa;
    throw e;
  }
  if (native.captioned) return native.result;
  // Description only — Exa may still have the transcript (tracks hidden from us).
  return (await extractViaExa(id, watchUrl, native.description)) ?? native.result;
}

interface NativeOutcome {
  result: Extracted;
  /** false = no captions were readable, `result` is the title + description only. */
  captioned: boolean;
  description: string;
}

/** The free caption chain (innertube clients → watch page). Throws the honest 422s. */
async function extractNative(id: string, watchUrl: string): Promise<NativeOutcome> {
  // Try each innertube client, then the watch page, keeping the best details we
  // see and stopping at the first source whose captions actually serve a body.
  let details: VideoDetails = {};
  let hadTracks = false; // a source listed caption tracks (so the video is captioned)
  let status: string | undefined;
  let reason: string | undefined;
  let transcript = "";
  let usedTrack: CaptionTrack | null = null;

  const note = (info: PlayerInfo | (PlayerInfo & { ok: boolean })) => {
    details = { ...info.details, ...details }; // earlier (better) sources win, later ones fill gaps
    if (info.status && info.status !== "OK" && !reason) {
      status = info.status;
      reason = info.reason;
    }
  };
  // Returns the track it read a body from (and sets `transcript`), else null.
  const tryTracks = async (tracks: CaptionTrack[], ua: string): Promise<CaptionTrack | null> => {
    if (!tracks.length) return null;
    hadTracks = true;
    const track = pickCaptionTrack(tracks);
    if (!track) return null;
    const segs = await fetchTranscript(track, ua);
    if (!segs.length) return null;
    transcript = segmentsToParagraphs(segs);
    return track;
  };

  for (const client of INNERTUBE_CLIENTS) {
    const info = await fetchPlayer(id, client);
    if (!info) continue;
    note(info);
    const t = await tryTracks(info.tracks, client.ua);
    if (t) {
      usedTrack = t;
      break;
    }
  }
  if (!transcript) {
    const page = await fetchWatchPage(watchUrl);
    if (page.ok) note(page);
    usedTrack = await tryTracks(page.tracks, BROWSER_UA);
  }

  const oembed = await fetchOEmbed(watchUrl);
  const title = (oembed.title ?? details.title ?? "").trim() || `YouTube video ${id}`;
  const author = (oembed.author ?? details.author ?? "").trim();
  const meta: Extracted["meta"] = { source_type: "video", source_platform: "youtube", source_url: watchUrl };
  if (details.lengthSeconds) meta.duration_s = details.lengthSeconds;
  const byline = [author ? `by ${author}` : "", "YouTube", details.lengthSeconds ? fmtDuration(details.lengthSeconds) : ""].filter(Boolean).join(" · ");

  if (!transcript) {
    // Captions exist but every source served an empty body → we're bot-walled
    // off the transcript itself. Never return that as an empty "success".
    if (hadTracks) throw new ExtractError(YT_BOT_WALL, 422);
    // A definitive non-bot reason (private / removed / members-only): say it.
    if (status && status !== "OK" && reason && !isBotReason(reason)) {
      throw new ExtractError(`YouTube won't serve this video to the Brain (${reason}). Paste the transcript instead.`, 422);
    }
    const description = collapseWhitespace(details.description ?? "");
    // No captions, but we did read the video — hand back the description, flagged.
    if (description) {
      return {
        result: { text: `# ${title}\n${byline}\n(no captions available — description only)\n\n${description}`, title, meta },
        captioned: false,
        description,
      };
    }
    // We know the video but there is nothing to read.
    if (details.title) throw new ExtractError("This video has no captions and no description to read. Paste the transcript instead.", 422);
    // Player + watch page both refused outright → the datacenter bot wall.
    throw new ExtractError(YT_BOT_WALL, 422);
  }

  const kind = usedTrack?.kind === "asr" ? "auto-generated captions" : `captions${usedTrack?.languageCode ? ` (${usedTrack.languageCode})` : ""}`;
  return { result: { text: `# ${title}\n${byline}\nTranscript from ${kind}:\n\n${transcript}`, title, meta }, captioned: true, description: "" };
}
