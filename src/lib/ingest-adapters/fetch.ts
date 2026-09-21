// One guarded outbound fetch for every adapter that touches the web.
//
// - SSRF guard (assertPublicUrl) on the requested URL AND on every redirect
//   hop — redirects are followed manually so a public URL cannot bounce the
//   server onto a private address.
// - Hard timeout and a byte cap: the body is streamed and cut at `maxBytes`,
//   so a 2 GB "page" never lands in memory.
// - A normal browser User-Agent: many sites serve an empty shell to bots.

import { assertPublicUrl } from "@/lib/net-guard";
import { ExtractError } from "./types";

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface GuardedFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  /** Request body (POST only); set the content-type in `headers`. */
  body?: string;
}

export interface GuardedResponse {
  status: number;
  contentType: string;
  /** The URL that finally answered (after redirects). */
  finalUrl: string;
  body: Buffer;
  text: string;
  /** True when the body was cut at `maxBytes`. */
  truncated: boolean;
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

async function assertSafe(url: string): Promise<void> {
  try {
    await assertPublicUrl(url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "not allowed";
    throw new ExtractError(`That link can't be fetched: ${msg.replace(/endpoint_url/g, "URL")}`, 400);
  }
}

export async function guardedFetch(url: string, opts: GuardedFetchOptions = {}): Promise<GuardedResponse> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 5;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let current = url;
  try {
    for (let hop = 0; ; hop++) {
      await assertSafe(current);
      let res: Response;
      try {
        res = await fetch(current, {
          method: opts.method ?? "GET",
          body: opts.method === "POST" ? opts.body : undefined,
          redirect: "manual",
          signal: ctrl.signal,
          headers: {
            "user-agent": BROWSER_UA,
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.8",
            ...(opts.headers ?? {}),
          },
        });
      } catch (e) {
        if (ctrl.signal.aborted) throw new ExtractError(`Timed out after ${Math.round(timeoutMs / 1000)}s fetching the link.`, 504);
        const msg = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
        throw new ExtractError(`Could not fetch the link (${msg}).`, 502);
      }

      if (REDIRECT.has(res.status)) {
        const loc = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!loc) throw new ExtractError("The link redirected without a destination.", 502);
        if (hop >= maxRedirects) throw new ExtractError("The link redirected too many times.", 502);
        const next = new URL(loc, current);
        // Browser semantics: 301/302/303 turn a POST into a GET without a body,
        // and caller headers (cookies, API tokens) never follow to another origin.
        if (res.status !== 307 && res.status !== 308) {
          opts = { ...opts, method: "GET", body: undefined };
        }
        if (next.origin !== new URL(current).origin) {
          opts = { ...opts, headers: undefined };
        }
        current = next.toString();
        continue;
      }

      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      const { body, truncated } = await readCapped(res, maxBytes, ctrl);
      return { status: res.status, contentType, finalUrl: current, body, text: decode(body, contentType), truncated };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Stream the body and stop at `maxBytes` (cancelling the rest). */
async function readCapped(res: Response, maxBytes: number, ctrl: AbortController): Promise<{ body: Buffer; truncated: boolean }> {
  if (!res.body) return { body: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (size + value.byteLength > maxBytes) {
        parts.push(value.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      parts.push(value);
      size += value.byteLength;
    }
  } catch (e) {
    if (ctrl.signal.aborted) throw new ExtractError("Timed out while downloading the page.", 504);
    throw new ExtractError(`Could not read the page (${e instanceof Error ? e.message : String(e)}).`, 502);
  }
  return { body: Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength))), truncated };
}

/** Decode with the charset the server declared (UTF-8 when absent or unknown). */
function decode(body: Buffer, contentType: string): string {
  const m = contentType.match(/charset=["']?([\w-]+)/i);
  const charset = (m?.[1] ?? "utf-8").toLowerCase();
  if (charset !== "utf-8" && charset !== "utf8") {
    try {
      return new TextDecoder(charset).decode(body);
    } catch {
      /* unknown label → utf-8 */
    }
  }
  return body.toString("utf-8");
}
