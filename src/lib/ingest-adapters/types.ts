// Shared shapes for the ingestion source adapters (src/lib/ingest-adapters/*).
//
// Every adapter turns ONE kind of source (a web page, a YouTube video, a PDF, a
// voice note, a screenshot …) into plain text plus light provenance, so the
// Knowledge Compiler keeps its text-in contract and never touches binary or
// the network itself. Adapters throw an ExtractError with a human-readable
// message; the routes map its `status` to the HTTP response.

export interface ExtractMeta {
  /** Taxonomy source type: video · audio · text · document · screenshot … */
  source_type?: string;
  /** Taxonomy platform: linkedin · instagram · x · facebook · tiktok · youtube · podcast · website */
  source_platform?: string;
  source_url?: string;
  duration_s?: number;
  pages?: number;
}

export interface Extracted {
  text: string;
  title?: string;
  meta: ExtractMeta;
}

/** A human-readable extraction failure. `status` is the HTTP status the routes reply with. */
export class ExtractError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "ExtractError";
    this.status = status;
  }
}
