// Exa web-contents API → readable text for links our own fetch can't read.
//
// Production runs on Vercel datacenter IPs: YouTube answers those with "sign in
// to confirm you're not a bot", and social hosts / some sites hand a server a
// login or JS shell. Exa (POST https://api.exa.ai/contents) reads the page from
// its own crawler and returns the text — for a YouTube video that is the full
// transcript. It is a paid call (~$0.001 a page), so the adapters use it where
// the free path fails: YouTube (first on Vercel, else after the native caption
// chain), social posts (beside the caption scrape) and blocked / JS-only pages.
//
//   exaContents(url, opts?)  → { url, title, text, author, publishedDate }
//                            → null when no Exa key is configured (callers fall back)
//                            → throws ExaError (an ExtractError with a `code`) on an
//                              API / network failure, a per-URL crawl error or empty text
//   tryExaContents(url, where, opts?) → the same, but null on any failure (logged)
//
// The key comes from getProviderKey("exa"): provider_secrets (encrypted; Settings →
// Provider API keys, or `npm run set:provider-key -- exa`) → EXA_API_KEY env. It is
// sent only in the x-api-key header, redacted from every message and never logged.
// The call goes through guardedFetch (SSRF guard, timeout, capped body) with
// redirects refused, so the header can never be replayed to another host.

import { guardedFetch, type GuardedResponse } from "./fetch";
import { MAX_LONG_TEXT_CHARS } from "./pure";
import { ExtractError } from "./types";
import { getProviderKey } from "@/lib/secrets";

export const EXA_CONTENTS_URL = "https://api.exa.ai/contents";
/** Exa's own ceiling for `text.maxCharacters` (the API answers 400 above it). */
export const EXA_MAX_CHARACTERS = 1_000_000;
const DEFAULT_TIMEOUT_MS = 25_000;
/** Body cap: 1M characters of text JSON-encoded (multi-byte / escaped) plus the envelope. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** "fallback": Exa's cache, crawling live on a miss. "always" forces a fresh crawl. */
export type ExaLivecrawl = "never" | "fallback" | "preferred" | "always";

export interface ExaContentsOptions {
  /** Max characters of text (default: the long-source cap, clamped to Exa's 1M limit). */
  maxCharacters?: number;
  livecrawl?: ExaLivecrawl;
  timeoutMs?: number;
}

export interface ExaPage {
  url: string;
  title: string | null;
  text: string;
  author: string | null;
  publishedDate: string | null;
}

export type ExaErrorCode =
  | "auth" // 401 / 403 — the key is wrong or revoked
  | "quota" // 402 — out of credits
  | "rate_limit" // 429
  | "bad_request" // 400 — Exa refused the request / the URL
  | "unavailable" // 200, but Exa could not crawl this URL (statuses[].error)
  | "upstream" // 5xx and anything else unexpected
  | "network" // could not reach Exa
  | "timeout"
  | "empty" // a result with no text
  | "bad_response"; // unparseable / oversized body

/** An Exa failure. The message is user-safe; `detail` (upstream text) is for server logs only. Neither ever holds the key. */
export class ExaError extends ExtractError {
  code: ExaErrorCode;
  detail?: string;
  constructor(message: string, status: number, code: ExaErrorCode, detail?: string) {
    super(message, status);
    this.name = "ExaError";
    this.code = code;
    this.detail = detail;
  }
}

/** Every occurrence of `secret` in `s` replaced (no-op without a secret). */
export function redactSecret(s: string, secret: string | undefined): string {
  return secret ? s.split(secret).join("[redacted]") : s;
}

/** Map a non-200 Exa reply to an ExaError (`detail` is redacted upstream text). */
export function exaHttpError(status: number, detail?: string): ExaError {
  if (status === 401 || status === 403) {
    return new ExaError(`Exa rejected the API key (HTTP ${status}). Check the Exa key in Settings → Provider API keys.`, 502, "auth", detail);
  }
  if (status === 402) return new ExaError("Exa credits are exhausted (HTTP 402).", 502, "quota", detail);
  if (status === 429) return new ExaError("Exa rate limit reached (HTTP 429). Try again in a minute.", 429, "rate_limit", detail);
  if (status === 400 || status === 422) return new ExaError(`Exa could not process this link (HTTP ${status}).`, 422, "bad_request", detail);
  return new ExaError(`Exa is unavailable (HTTP ${status}).`, 502, "upstream", detail);
}

/** Upstream error text worth logging: `error` / `tag` from a JSON body, else the raw start. */
function upstreamDetail(body: string, secret: string): string | undefined {
  let d = body;
  try {
    const j = JSON.parse(body) as { error?: unknown; tag?: unknown };
    d = [typeof j.tag === "string" ? j.tag : "", typeof j.error === "string" ? j.error : ""].filter(Boolean).join(": ") || body;
  } catch {
    /* not JSON — keep the raw text */
  }
  d = redactSecret(d, secret).replace(/\s+/g, " ").trim().slice(0, 300);
  return d || undefined;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Parse a 200 body into the first page, or throw the matching ExaError. */
export function parseExaContents(body: string, requestedUrl: string, secret = ""): ExaPage {
  let j: { results?: unknown; statuses?: unknown };
  try {
    j = JSON.parse(body) as typeof j;
  } catch {
    throw new ExaError("Exa returned an unreadable response.", 502, "bad_response", upstreamDetail(body, secret));
  }
  const status = Array.isArray(j.statuses) ? (j.statuses[0] as { status?: unknown; error?: { tag?: unknown; httpStatusCode?: unknown } } | undefined) : undefined;
  const result = Array.isArray(j.results) ? (j.results[0] as Record<string, unknown> | undefined) : undefined;
  if (!result || status?.status === "error") {
    const tag = typeof status?.error?.tag === "string" && /^[A-Z0-9_]{1,64}$/.test(status.error.tag) ? status.error.tag : null;
    const code = typeof status?.error?.httpStatusCode === "number" ? ` HTTP ${status.error.httpStatusCode}` : "";
    throw new ExaError(`Exa couldn't read this link${tag ? ` (${tag}${code})` : ""}.`, 422, "unavailable", tag ? `${tag}${code}` : undefined);
  }
  const text = (typeof result.text === "string" ? result.text : "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new ExaError("Exa returned no text for this link.", 422, "empty");
  return {
    url: str(result.url) ?? requestedUrl,
    title: str(result.title),
    text,
    author: str(result.author),
    publishedDate: str(result.publishedDate),
  };
}

export async function exaContents(url: string, opts: ExaContentsOptions = {}): Promise<ExaPage | null> {
  const key = (await getProviderKey("exa"))?.trim();
  if (!key) return null;

  const maxCharacters = Math.max(1, Math.min(Math.floor(opts.maxCharacters ?? MAX_LONG_TEXT_CHARS), EXA_MAX_CHARACTERS));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let res: GuardedResponse;
  try {
    res = await guardedFetch(EXA_CONTENTS_URL, {
      method: "POST",
      timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      maxRedirects: 0,
      headers: { "content-type": "application/json", accept: "application/json", "x-api-key": key },
      body: JSON.stringify({ urls: [url], text: { maxCharacters }, livecrawl: opts.livecrawl ?? "fallback" }),
    });
  } catch (e) {
    const msg = redactSecret(e instanceof Error ? e.message : String(e), key).slice(0, 300);
    if (e instanceof ExtractError && e.status === 504) {
      throw new ExaError(`Exa timed out after ${Math.round(timeoutMs / 1000)}s.`, 504, "timeout", msg);
    }
    throw new ExaError("Could not reach Exa.", 502, "network", msg);
  }

  if (res.status !== 200) throw exaHttpError(res.status, upstreamDetail(res.text, key));
  if (res.truncated) throw new ExaError("Exa's response was larger than the limit.", 502, "bad_response");
  return parseExaContents(res.text, url, key);
}

/** One line in the server log for an Exa failure — message, code and redacted detail only. */
export function logExaFailure(where: string, e: unknown): void {
  if (e instanceof ExaError) {
    console.warn(`[exa] ${where}: ${e.code} — ${e.message}${e.detail ? ` (${e.detail})` : ""}`);
  } else {
    console.warn(`[exa] ${where}: unexpected failure (${e instanceof Error ? e.name : typeof e})`);
  }
}

/** exaContents, but null on any failure (logged) — for callers that fall back to their own path. */
export async function tryExaContents(url: string, where: string, opts?: ExaContentsOptions): Promise<ExaPage | null> {
  try {
    return await exaContents(url, opts);
  } catch (e) {
    logExaFailure(where, e);
    return null;
  }
}
