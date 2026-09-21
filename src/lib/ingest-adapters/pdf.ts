// PDF → text with pdf-parse — the same library and internal entry point the
// upload path uses (pdfToText in src/lib/ingest.ts); this one also returns the
// page count and the embedded Title so the wizard can show/prefill them.

// Internal entry (not the package root) to avoid pdf-parse's module-level
// debug branch that reads a bundled test PDF from disk.
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { collapseWhitespace } from "./url";
import { ExtractError, type Extracted } from "./types";

/** 50 MB — a book-sized PDF arrives via secure storage (a direct upload stops at 4 MB). */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

export async function extractPdf(buffer: Buffer): Promise<Extracted> {
  if (buffer.length === 0) throw new ExtractError("The PDF file is empty.", 400);
  if (buffer.length > MAX_PDF_BYTES) throw new ExtractError("PDF is too large — files up to 50 MB are supported.", 413);

  let parsed: Awaited<ReturnType<typeof pdfParse>>;
  try {
    parsed = await pdfParse(buffer);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/password|encrypt/i.test(msg)) throw new ExtractError("This PDF is password-protected. Remove the password and try again.", 422);
    throw new ExtractError(`Could not read the PDF (${msg}).`, 422);
  }

  const text = collapseWhitespace(parsed.text ?? "");
  if (!text) {
    throw new ExtractError("This PDF is a scan (no text layer). Export it with OCR — e.g. Adobe 'Recognize text' or Google Drive 'Open with Docs' — and upload the result.", 422);
  }
  const info = (parsed.info ?? {}) as { Title?: unknown };
  const title = typeof info.Title === "string" ? info.Title.trim().slice(0, 200) : "";
  return { text, title: title || undefined, meta: { source_type: "document", pages: parsed.numpages } };
}
