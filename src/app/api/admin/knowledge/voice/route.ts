// POST /api/admin/knowledge/voice — transcribe a recorded voice note into text
// for the Add-knowledge wizard (and other big text boxes).
//
// The dashboard's mic records in the browser and POSTs the audio here; we
// admin-guard the request (documents:write), then transcribe it with the same
// OpenAI transcription the ingest adapters use. The transcript is returned as
// { text, kind: "audio" } and the wizard appends it to the paste box.
//
// SECURITY: org_id / auth are resolved server-side (never from the body). The
// transcript is DATA; we never log the audio or the transcript.

import { guard } from "../_shared";
import { transcribeAudio, MAX_AUDIO_BYTES } from "@/lib/ingest-adapters/audio";
import { ExtractError } from "@/lib/ingest-adapters/types";
import { isDemo } from "@/lib/demo/mode";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
// A short dictation transcribes in seconds; the ceiling covers a longer note.
export const maxDuration = 300;

export async function POST(req: Request) {
  const g = await guard("documents:write");
  if ("response" in g) return g.response;

  // DEMO MODE runs with no OpenAI key — return a canned transcript so the mic is
  // clickable in a click-through demo.
  if (isDemo()) {
    return Response.json({ text: "[demo] transcribed voice note", kind: "audio" }, { status: 200 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Expected a multipart upload." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "No audio provided." }, { status: 400 });
  }
  if (file.size === 0) {
    return Response.json({ error: "The recording was empty." }, { status: 400 });
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return Response.json(
      { error: "Recording too long — keep dictation under a few minutes." },
      { status: 413 }
    );
  }

  const name = (file.name || "voice.webm").slice(0, 200);
  const mime = file.type || null;
  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const { text } = await transcribeAudio(buffer, name, mime);
    if (!text?.trim()) {
      return Response.json({ error: "No speech detected in the recording." }, { status: 422 });
    }
    return Response.json({ text, kind: "audio" }, { status: 200 });
  } catch (e) {
    // The adapter throws ExtractError with a user-safe message + HTTP status
    // (e.g. 400 when no OpenAI key is configured, 413 too large, 503 quota).
    if (e instanceof ExtractError) {
      return Response.json({ error: e.message }, { status: e.status ?? 502 });
    }
    return Response.json(
      { error: e instanceof Error ? e.message : "Could not transcribe the recording." },
      { status: 502 }
    );
  }
}
