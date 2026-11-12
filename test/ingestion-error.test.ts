import {describe,it,expect} from "vitest";
import {ingestionErrorSummary} from "@/lib/ingestion-error";

describe("operator error messages",()=>{
  it("explains a timeout even when an old log incorrectly blamed a migration",()=>{
    expect(ingestionErrorSummary("Source refresh failed (migration 0021 is required): canceling statement due to statement timeout")).toContain("took too long");
  });
  it("does not put an upstream HTML error page into the dashboard",()=>{
    const result=ingestionErrorSummary('<!DOCTYPE html><html>520 Cloudflare error secret-url</html>');
    expect(result).toContain("temporarily unavailable");
    expect(result).not.toMatch(/html|Cloudflare|secret-url/);
  });
  it("does not expose unknown provider details",()=>{
    expect(ingestionErrorSummary("Error at https://provider.invalid?api_key=secret")).not.toContain("secret");
  });
});
