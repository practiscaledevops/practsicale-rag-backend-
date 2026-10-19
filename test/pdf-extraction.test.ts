import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractPdf } from "@/lib/ingest-adapters/pdf";
import { pdfToText } from "@/lib/ingest";

const fixture = () => readFileSync(new URL("./fixtures/text.pdf", import.meta.url));
const text = "Local verification fixture: attachment extraction works.";

describe("PDF Buffer inputs", () => {
  it("extracts a valid text PDF uploaded through the source adapter", async () => {
    const extracted = await extractPdf(fixture());
    expect(extracted.text).toContain(text);
    expect(extracted.meta.pages).toBe(1);
  });

  it("extracts the same PDF through the ingestion upload path", async () => {
    expect(await pdfToText(fixture())).toContain(text);
  });
});
