// The universal ingestion entry: give it a link or a file, get text + light
// provenance back. One dispatcher so Instagram/YouTube/LinkedIn clips, books,
// PDFs, calls, voice notes and screenshots all reach the Knowledge Compiler
// through the same door (spec §29–30).
//
//   extractAny({ url })                        → youtube | url
//   extractAny({ file: { name, mime, buffer }}) → pdf | audio | image | text
//   extractAny(input, { full: true })           → same, with the LONG text cap (2M chars)
//                                                 for the wizard's long-source ("book") mode
//
// Server-only (SDKs, pdf-parse, DNS). The client-safe helpers live in ./pure.

import { extractFromUrl } from "./url";
import { extractFromYouTube } from "./youtube";
import { extractFathom } from "./fathom";
import { extractPdf } from "./pdf";
import { transcribeAudio } from "./audio";
import { extractImageText } from "./image";
import { capText, extOf, isYouTubeUrl, isFathomUrl, kindOfFile, IMAGE_MIME, MAX_TEXT_CHARS, MAX_LONG_TEXT_CHARS, type ExtractKind } from "./pure";
import { ExtractError, type Extracted, type ExtractMeta } from "./types";

export type { ExtractKind } from "./pure";
export type { Extracted, ExtractMeta } from "./types";
export { ExtractError } from "./types";
export { capText, kindOfFile, isYouTubeUrl, isFathomUrl, parseYouTubeId, MAX_TEXT_CHARS, MAX_LONG_TEXT_CHARS } from "./pure";

export interface ExtractInput {
  url?: string;
  file?: { name: string; mime?: string | null; buffer: Buffer };
}

export interface ExtractOptions {
  /** Lift the 60k cap to MAX_LONG_TEXT_CHARS — admin wizard only (a long source is split into chapters there). */
  full?: boolean;
}

export interface ExtractResult {
  /** The page/video title for a link, the filename for an upload. */
  name: string;
  kind: ExtractKind;
  /** The source's own title when it has one (og:title, video title, PDF Title). */
  title: string | null;
  text: string;
  chars: number;
  truncated: boolean;
  meta: ExtractMeta;
}

const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;

/** UTF-8 decode (BOM stripped) for .txt/.md/.csv/.json uploads. */
function decodeTextFile(buffer: Buffer, name: string): Extracted {
  if (buffer.length === 0) throw new ExtractError("The file is empty.", 400);
  if (buffer.length > MAX_TEXT_FILE_BYTES) throw new ExtractError("Text file is too large (max 5 MB).", 413);
  let text = buffer.toString("utf-8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n?/g, "\n").trim();
  if (!text) throw new ExtractError("The file contains no text.", 422);
  return { text, meta: { source_type: extOf(name) === ".json" || extOf(name) === ".csv" ? "document" : "text" } };
}

function finish(kind: ExtractKind, name: string, r: Extracted, opts?: ExtractOptions): ExtractResult {
  const capped = capText(r.text, opts?.full ? MAX_LONG_TEXT_CHARS : MAX_TEXT_CHARS);
  return {
    name: name.slice(0, 200),
    kind,
    title: r.title?.trim() ? r.title.trim().slice(0, 200) : null,
    text: capped.text,
    chars: capped.text.length,
    truncated: capped.truncated,
    meta: r.meta,
  };
}

export async function extractAny(input: ExtractInput, opts?: ExtractOptions): Promise<ExtractResult> {
  if (input.url && input.url.trim()) {
    const url = input.url.trim();
    if (isYouTubeUrl(url)) {
      const r = await extractFromYouTube(url);
      return finish("youtube", r.title ?? url, r, opts);
    }
    // Fathom before the generic url adapter — a share link is a login wall to the
    // page scraper, but its transcript endpoint is token-authed (see ./fathom).
    if (isFathomUrl(url)) {
      const r = await extractFathom(url);
      return finish("url", r.title ?? url, r, opts);
    }
    const r = await extractFromUrl(url);
    return finish("url", r.title ?? url, r, opts);
  }

  if (input.file) {
    const { name, mime, buffer } = input.file;
    const kind = kindOfFile(name, mime);
    if (!kind) {
      throw new ExtractError(
        `Unsupported file type '${extOf(name) || mime || name}'. Use a PDF, text (.txt .md .csv .json), audio (.mp3 .m4a .wav .mp4 .webm .ogg) or an image (.png .jpg .webp .gif).`,
        415
      );
    }
    let r: Extracted;
    switch (kind) {
      case "pdf":
        r = await extractPdf(buffer);
        break;
      case "audio":
        r = await transcribeAudio(buffer, name, mime);
        break;
      case "image":
        r = await extractImageText(buffer, IMAGE_MIME[extOf(name)] ?? mime ?? "");
        break;
      default:
        r = decodeTextFile(buffer, name);
    }
    return finish(kind, name, r, opts);
  }

  throw new ExtractError("Provide a url or attach a file.", 400);
}
