import { describe, it, expect } from "vitest";
import { parseFathomUrl, fathomHtmlToTranscript, parseFathomTitle, parseFathomDuration } from "@/lib/ingest-adapters/fathom";

// Pure parts only — no network.

describe("parseFathomUrl", () => {
  it("reads the share form", () => {
    expect(parseFathomUrl("https://fathom.video/share/abc123")).toEqual({ shareId: "abc123" });
    expect(parseFathomUrl("https://www.fathom.video/share/ABC-def_123?x=1")).toEqual({ shareId: "ABC-def_123" });
  });

  it("reads the calls form (token from the query, else the path id)", () => {
    expect(parseFathomUrl("https://fathom.video/calls/833455201?timestamp=17")).toEqual({ shareId: "833455201" });
    expect(parseFathomUrl("https://fathom.video/calls/833455201?share=tok_9&t=1")).toEqual({ shareId: "tok_9" });
    expect(parseFathomUrl("https://fathom.video/calls/833455201?token=tok_9")).toEqual({ shareId: "tok_9" });
  });

  it("returns null for non-fathom or unparseable links", () => {
    for (const u of [
      "https://fathom.video.evil.com/share/x",
      "https://example.com/share/abc",
      "https://fathom.video/",
      "https://fathom.video/pricing",
      "not a url",
      "",
    ]) {
      expect(parseFathomUrl(u), u).toBeNull();
    }
  });
});

describe("fathomHtmlToTranscript", () => {
  // Shaped like Fathom's copy_transcript payload: an <h1> title, then per-turn a
  // <p> with an @m:ss anchor + <b> speaker, followed by <p> body paragraphs.
  const html = `<h1>Impromptu Zoom Meeting - Sep 22</h1>
    <p><a href="https://fathom.video/calls/833455201?timestamp=17.02">@0:17</a> - <b>Sherman Mathews (sherman@acme.com)</b></p>
    <p>Good afternoon everyone, thanks for joining.</p>
    <p>Let&#39;s get started.</p>
    <p><a href="https://fathom.video/calls/833455201?timestamp=45.5">@0:45</a> - <b>Jane Doe</b></p>
    <p>Happy to be here.</p>`;

  it("extracts the title and expands the month abbreviation", () => {
    const { title } = fathomHtmlToTranscript(html);
    expect(title).toBe("Impromptu Zoom Meeting - September 22");
  });

  it("parses turns keeping timestamps and speakers, dropping the speaker's email", () => {
    const { text } = fathomHtmlToTranscript(html);
    expect(text.startsWith("Impromptu Zoom Meeting - September 22\n\n")).toBe(true);
    // Timestamp + clean speaker, body on the next indented line; extra body <p>s fold in.
    expect(text).toContain("0:17 - Sherman Mathews\n  Good afternoon everyone, thanks for joining. Let's get started.");
    expect(text).toContain("0:45 - Jane Doe\n  Happy to be here.");
    expect(text).not.toContain("sherman@acme.com");
    // Two turns, separated by a blank line.
    expect(text.split("\n\n").filter((s) => /^\d/.test(s))).toHaveLength(2);
  });

  it("handles an h:mm:ss timestamp", () => {
    const { text } = fathomHtmlToTranscript(`<p><a href="?timestamp=3700">@1:01:40</a> - <b>Speaker</b></p><p>Words.</p>`);
    expect(text).toContain("1:01:40 - Speaker\n  Words.");
  });
});

describe("parseFathomTitle / parseFathomDuration", () => {
  it("reads the config title (already entity-decoded)", () => {
    expect(parseFathomTitle('{"call":{"id":833455201,"title":"Impromptu Zoom Meeting"}}')).toBe("Impromptu Zoom Meeting");
    expect(parseFathomTitle("no title here")).toBeNull();
  });

  it("derives an approximate duration from the largest transcript timestamp", () => {
    const html = `<p><a href="?timestamp=17.02">@0:17</a></p><p><a href="?timestamp=633.5">@10:33</a></p>`;
    expect(parseFathomDuration(html)).toBe(634);
    expect(parseFathomDuration("<p>no anchors</p>")).toBeUndefined();
  });
});
