// The universal ingestion entry: give it a link or a file, get text + light
// provenance back. One dispatcher so Instagram/YouTube/LinkedIn clips, books,
// PDFs, calls, voice notes and screenshots all reach the Knowledge Compiler
// through the same door (spec §29–30).
//
//   extractAny({ url })                        → youtube | url
//   extractAny({ file: { name, mime, buffer }}) → pdf | audio | image | text
//
// Server-only (SDKs, pdf-parse, DNS). The client-safe helpers live in ./pure.

import { extractFromUrl } from "./url";
import { extractFromYouTube } from "./youtube";
import { extractPdf } from "./pdf";
import { transcribeAudio } from "./audio";
import { extractImageText } from "./image";
import { capText, extOf, isYouTubeUrl, kindOfFile, IMAGE_MIME, MAX_TEXT_CHARS, type ExtractKind } from "./pure";
import { ExtractError, type Extracted, type ExtractMeta } from "./types";

export type { ExtractKind } from "./pure";
export type { Extracted, ExtractMeta } from "./types";
export { ExtractError } from "./types";
export { capText, kindOfFile, isYouTubeUrl, parseYouTubeId, MAX_TEXT_CHARS } from "./pure";

export interface ExtractInput {
  url?: string;
  file?: { name: string; mime?: string | null; buffer: Buffer };
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

function finish(kind: ExtractKind, name: string, r: Extracted): ExtractResult {
  const capped = capText(r.text, MAX_TEXT_CHARS);
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

export async function extractAny(input: ExtractInput): Promise<ExtractResult> {
  if (input.url && input.url.trim()) {
    const url = input.url.trim();
    if (isYouTubeUrl(url)) {
      const r = await extractFromYouTube(url);
      return finish("youtube", r.title ?? url, r);
    }
    const r = await extractFromUrl(url);
    return finish("url", r.title ?? url, r);
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
    return finish(kind, name, r);
  }

  throw new ExtractError("Provide a url or attach a file.", 400);
}
