// Minimal type declaration for pdf-parse.
//
// We import the internal entry ("pdf-parse/lib/pdf-parse.js") rather than the
// package root to avoid pdf-parse's module-level debug branch (which reads a
// bundled test PDF from disk). @types/pdf-parse only declares the root module,
// so we declare the internal path (and the root, for completeness) here.

declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    /** Concatenated text content of the PDF. */
    text: string;
    /** Number of pages. */
    numpages: number;
    /** PDF info dictionary (title, author, etc.), when present. */
    info?: unknown;
    /** PDF metadata, when present. */
    metadata?: unknown;
    /** pdf.js version used to parse. */
    version?: string;
  }

  function pdfParse(
    dataBuffer: Buffer | Uint8Array,
    options?: Record<string, unknown>
  ): Promise<PdfParseResult>;

  export default pdfParse;
}

declare module "pdf-parse" {
  import pdfParse from "pdf-parse/lib/pdf-parse.js";
  export default pdfParse;
}
