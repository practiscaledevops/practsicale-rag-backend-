// Screenshot / photo → the text in it, via OpenAI vision (gpt-4o-mini). The
// model is told to transcribe only — tables as Markdown, charts as their data,
// no commentary — so what lands in the Brain is the source, not an opinion.
// The image is untrusted data: anything it "says" is transcribed, never obeyed.

import OpenAI from "openai";
import { getProviderKey } from "@/lib/secrets";
import { ExtractError, type Extracted } from "./types";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MODEL = "gpt-4o-mini";
const INSTRUCTION =
  "Transcribe every piece of text in this image faithfully, in reading order. Render tables as Markdown tables and charts as their data. Do not add commentary.";

const ACCEPTED: Record<string, string> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
};

export const NO_KEY_MESSAGE = "Add an OpenAI key in Settings → Provider API keys to read screenshots.";

export async function extractImageText(buffer: Buffer, mime: string): Promise<Extracted> {
  const type = ACCEPTED[(mime ?? "").toLowerCase().split(";")[0].trim()];
  if (!type) throw new ExtractError(`Unsupported image type '${mime || "unknown"}'. Use png, jpg, webp or gif.`, 415);
  if (buffer.length === 0) throw new ExtractError("The image file is empty.", 400);
  if (buffer.length > MAX_IMAGE_BYTES) throw new ExtractError("Image is too large (max 10 MB).", 413);

  const key = await getProviderKey("openai");
  if (!key) throw new ExtractError(NO_KEY_MESSAGE, 400);
  const client = new OpenAI({ apiKey: key, maxRetries: 1, timeout: 90_000 });

  let text = "";
  try {
    const r = await client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      max_tokens: 4096,
      // The instruction lives in the system turn so text inside the screenshot
      // ("ignore the above…") is data the model transcribes, not a peer instruction.
      messages: [
        { role: "system", content: INSTRUCTION },
        {
          role: "user",
          content: [
            { type: "text", text: "Transcribe this image." },
            { type: "image_url", image_url: { url: `data:${type};base64,${buffer.toString("base64")}`, detail: "high" } },
          ],
        },
      ],
    });
    text = r.choices[0]?.message?.content?.trim() ?? "";
  } catch (e) {
    if (e instanceof OpenAI.APIError) {
      if (e.status === 401) throw new ExtractError("OpenAI rejected the configured API key. Check Settings → Provider API keys.", 400);
      if (e.status === 429) throw new ExtractError("OpenAI rate limit / quota reached while reading the image. Try again in a minute.", 503);
      throw new ExtractError(`Reading the image failed (${e.message}).`, 502);
    }
    throw new ExtractError(`Reading the image failed (${e instanceof Error ? e.message : String(e)}).`, 502);
  }

  // The model answers with a short refusal-style line when there is nothing to read.
  if (!text || /^(there is|there's|i (can't|cannot|don't) see|no (readable |visible )?text)/i.test(text) && text.length < 120) {
    throw new ExtractError("No readable text was found in the image.", 422);
  }
  return { text, meta: { source_type: "screenshot" } };
}
