// Voice note / call recording → transcript, via OpenAI transcription. The key
// comes from getProviderKey (dashboard-set key overrides env — same as
// embeddings.ts); the client is built per call so a rotated key is picked up.
// gpt-4o-mini-transcribe first, whisper-1 when the account can't use it.

import OpenAI, { toFile } from "openai";
import { getProviderKey } from "@/lib/secrets";
import { AUDIO_EXT, AUDIO_MIME, extOf } from "./pure";
import { ExtractError, type Extracted } from "./types";

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // OpenAI's upload limit
const PRIMARY_MODEL = "gpt-4o-mini-transcribe";
const FALLBACK_MODEL = "whisper-1";

export const NO_KEY_MESSAGE = "Add an OpenAI key in Settings → Provider API keys to transcribe audio.";

const MIME_TO_EXT: Record<string, string> = {
  "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/m4a": ".m4a",
  "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/wave": ".wav", "audio/webm": ".webm", "video/webm": ".webm",
  "video/mp4": ".mp4", "audio/ogg": ".ogg", "audio/mpga": ".mp3",
};

/** True for a model-availability failure (unknown model / not enabled for this key), not an auth or size failure. */
function isModelError(e: unknown): boolean {
  if (!(e instanceof OpenAI.APIError)) return false;
  const code = String((e as { code?: string }).code ?? "");
  return code === "model_not_found" || e.status === 404 || ((e.status === 400 || e.status === 403) && /model/i.test(e.message));
}

function toExtractError(e: unknown, what: string): ExtractError {
  if (e instanceof OpenAI.APIError) {
    if (e.status === 401) return new ExtractError("OpenAI rejected the configured API key. Check Settings → Provider API keys.", 400);
    if (e.status === 413) return new ExtractError("Audio is too large for the transcription service (max 25 MB).", 413);
    if (e.status === 429) return new ExtractError("OpenAI rate limit / quota reached while transcribing. Try again in a minute.", 503);
    return new ExtractError(`${what} failed (${e.message}).`, 502);
  }
  return new ExtractError(`${what} failed (${e instanceof Error ? e.message : String(e)}).`, 502);
}

export async function transcribeAudio(buffer: Buffer, filename: string, mime?: string | null): Promise<Extracted> {
  const m = (mime ?? "").toLowerCase().split(";")[0].trim();
  let ext = extOf(filename || "");
  if (!AUDIO_EXT.includes(ext)) ext = MIME_TO_EXT[m] ?? "";
  if (!ext) throw new ExtractError(`Unsupported audio type '${extOf(filename) || m || filename}'. Use mp3, m4a, wav, mp4, webm, ogg or mpeg.`, 415);
  if (buffer.length === 0) throw new ExtractError("The audio file is empty.", 400);
  if (buffer.length > MAX_AUDIO_BYTES) throw new ExtractError("Audio is too large (max 25 MB). Trim it or export it at a lower bitrate.", 413);

  const key = await getProviderKey("openai");
  if (!key) throw new ExtractError(NO_KEY_MESSAGE, 400);
  // One attempt per model, bounded so primary + fallback fit inside the route's
  // 120s function limit (a platform 504 carries no message for the user).
  const client = new OpenAI({ apiKey: key, maxRetries: 0, timeout: 45_000 });
  const startedAt = Date.now();

  // A safe, recognisable filename: the API sniffs the container from the extension.
  const name = `audio${ext}`;
  const type = AUDIO_MIME[ext] ?? m ?? "application/octet-stream";
  const upload = () => toFile(buffer, name, { type });

  let text = "";
  let duration: number | undefined;
  try {
    const r = await client.audio.transcriptions.create({ file: await upload(), model: PRIMARY_MODEL, response_format: "json" });
    text = r.text ?? "";
  } catch (e) {
    if (!isModelError(e)) throw toExtractError(e, "Transcription");
    if (Date.now() - startedAt > 50_000) throw toExtractError(e, "Transcription");
    try {
      const r = await client.audio.transcriptions.create({ file: await upload(), model: FALLBACK_MODEL, response_format: "verbose_json" });
      text = r.text ?? "";
      if (Number.isFinite(r.duration)) duration = Math.round(r.duration);
    } catch (e2) {
      throw toExtractError(e2, "Transcription");
    }
  }

  text = text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();
  if (!text) throw new ExtractError("The transcription came back empty — is there speech in the recording?", 422);

  const meta: Extracted["meta"] = { source_type: type.startsWith("video/") ? "video" : "audio" };
  if (duration) meta.duration_s = duration;
  const title = (filename || "").replace(/\.[^.]+$/, "").trim();
  return { text, title: title || undefined, meta };
}
