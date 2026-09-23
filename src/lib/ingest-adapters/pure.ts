// Pure, dependency-free helpers shared by the server adapters, the extract
// routes and the Add-knowledge wizard (client). Nothing here touches the
// network, the file system or an SDK — keep it that way so the wizard can
// import it and the unit tests need no mocks.

export type ExtractKind = "url" | "youtube" | "pdf" | "audio" | "image" | "text";

/** Returned text is capped so a 300-page PDF cannot blow up the compiler prompt. */
export const MAX_TEXT_CHARS = 60_000;
/**
 * The LONG cap, for the wizard's long-source ("book") mode only: the admin
 * extract route lifts the 60k cap to this when asked for `full` text, and the
 * wizard then splits the source into chapters (src/lib/long-source-pure.ts).
 * ~2 MB of JSON — under the platform's 4.5 MB response limit.
 */
export const MAX_LONG_TEXT_CHARS = 2_000_000;

/** A file up to this size is POSTed straight to the extract route (the hosting platform rejects bodies over ~4.5 MB). */
export const MAX_DIRECT_UPLOAD_BYTES = 4 * 1024 * 1024;
/** A bigger file goes through secure storage (signed upload URL) — up to this size. */
export const MAX_STORAGE_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Per-kind ceilings the adapters enforce (audio: the transcription service's limit). */
export const MAX_BYTES_BY_KIND: Record<Exclude<ExtractKind, "url" | "youtube">, number> = {
  pdf: 50 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  image: 10 * 1024 * 1024,
  text: 5 * 1024 * 1024,
};

export const TEXT_EXT = [".txt", ".text", ".md", ".markdown", ".csv", ".json"];
export const AUDIO_EXT = [".mp3", ".m4a", ".wav", ".mp4", ".webm", ".ogg", ".mpeg", ".mpga", ".oga"];
export const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

export const AUDIO_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".mpga": "audio/mpeg",
  ".mpeg": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
};
export const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
}

/**
 * Which adapter handles a file: the extension decides first (browsers report
 * unreliable MIME types for .md/.m4a), the MIME type is the fallback for a
 * file that has no usable extension. null = unsupported.
 */
export function kindOfFile(name: string, mime?: string | null): Exclude<ExtractKind, "url" | "youtube"> | null {
  const ext = extOf(name || "");
  if (ext === ".pdf") return "pdf";
  if (TEXT_EXT.includes(ext)) return "text";
  if (AUDIO_EXT.includes(ext)) return "audio";
  if (IMAGE_EXT.includes(ext)) return "image";
  const m = (mime ?? "").toLowerCase().split(";")[0].trim();
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("audio/") || m === "video/mp4" || m === "video/webm") return "audio";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("text/") || m === "application/json") return "text";
  return null;
}

const YT_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com"];

/** True when the URL points at a YouTube video page (any of the host/path shapes). */
export function isYouTubeUrl(url: string): boolean {
  return parseYouTubeId(url) !== null;
}

/**
 * True when the URL is a Fathom recording link (host `fathom.video`). Routing
 * only needs the host — the fathom adapter parses the share id and call id
 * itself (parseFathomUrl in ./fathom).
 */
export function isFathomUrl(url: string): boolean {
  try {
    return new URL(url.trim()).hostname.toLowerCase().replace(/^www\./, "") === "fathom.video";
  } catch {
    return false;
  }
}

/**
 * The 11-character video id from any of the common URL shapes:
 * watch?v=ID · youtu.be/ID · /shorts/ID · /embed/ID · /live/ID · /v/ID.
 * null for anything else (including a bare channel or playlist URL).
 */
export function parseYouTubeId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!YT_HOSTS.includes(host)) return null;
  const ok = (id: string | null | undefined) => (id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null);
  if (host.endsWith("youtu.be")) return ok(u.pathname.split("/").filter(Boolean)[0]);
  const v = ok(u.searchParams.get("v"));
  if (v) return v;
  const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})(?:[/?]|$)/);
  return m ? m[1] : null;
}

/** Cap the returned text at MAX_TEXT_CHARS, cutting on a line break where possible. */
export function capText(text: string, max = MAX_TEXT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let cut = text.lastIndexOf("\n", max);
  if (cut < max * 0.8) cut = max;
  return {
    text: `${text.slice(0, cut).trimEnd()}\n\n[… truncated to ${max.toLocaleString("en-US")} characters — the source was ${text.length.toLocaleString("en-US")}]`,
    truncated: true,
  };
}

/** The user-facing progress label for each kind (used by the wizard). */
export const PROGRESS_LABEL: Record<ExtractKind, string> = {
  url: "Fetching page…",
  youtube: "Fetching the video's captions…",
  pdf: "Reading PDF…",
  text: "Reading file…",
  audio: "Transcribing audio… this can take a minute",
  image: "Reading screenshot…",
};

/** "3.2 MB" style size for the wizard's file chip. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
