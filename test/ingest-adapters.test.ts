import { describe, it, expect, vi } from "vitest";
import { parseYouTubeId, isYouTubeUrl, isFathomUrl, kindOfFile, capText, MAX_TEXT_CHARS } from "@/lib/ingest-adapters/pure";
import { htmlToText, stripHtml, htmlTitle, decodeEntities, platformOfHost, socialCaption } from "@/lib/ingest-adapters/url";
import { readJsonValue, parseCaptionTracks, pickCaptionTrack, parseVideoDetails, parseJson3, parseTimedTextXml, parseTimedText, segmentsToParagraphs } from "@/lib/ingest-adapters/youtube";
import { extractAny, ExtractError } from "@/lib/ingest-adapters";
import { extractFathom } from "@/lib/ingest-adapters/fathom";

// Pure parts only — no network, no SDK calls. The fathom adapter (which would
// fetch) is stubbed so the dispatch can be exercised without a network call.
vi.mock("@/lib/ingest-adapters/fathom", () => ({
  extractFathom: vi.fn(async (url: string) => ({
    text: "CALL TRANSCRIPT",
    title: "Impromptu Zoom Meeting",
    meta: { source_type: "call", source_platform: "fathom", source_url: url },
  })),
}));

describe("parseYouTubeId", () => {
  it("reads every common URL shape", () => {
    const id = "dQw4w9WgXcQ";
    for (const u of [
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtube.com/watch?v=${id}&t=42s`,
      `https://m.youtube.com/watch?feature=share&v=${id}`,
      `https://youtu.be/${id}`,
      `https://youtu.be/${id}?si=abc`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/embed/${id}`,
      `https://www.youtube.com/live/${id}?feature=share`,
      `  https://www.youtube.com/watch?v=${id}  `,
    ]) {
      expect(parseYouTubeId(u), u).toBe(id);
      expect(isYouTubeUrl(u), u).toBe(true);
    }
  });

  it("rejects non-video and non-YouTube links", () => {
    for (const u of [
      "https://www.youtube.com/@somechannel",
      "https://www.youtube.com/playlist?list=PL123",
      "https://www.youtube.com/watch?v=tooshort",
      "https://vimeo.com/123456",
      "https://example.com/watch?v=dQw4w9WgXcQ",
      "not a url",
      "",
    ]) {
      expect(parseYouTubeId(u), u).toBeNull();
      expect(isYouTubeUrl(u), u).toBe(false);
    }
  });
});

describe("isFathomUrl", () => {
  it("recognizes fathom.video share and call links", () => {
    for (const u of [
      "https://fathom.video/share/abc123",
      "https://fathom.video/share/ABC-def_123?x=1",
      "https://fathom.video/calls/833455201?timestamp=1",
      "https://www.fathom.video/share/xyz",
      "  https://fathom.video/share/xyz  ",
    ]) {
      expect(isFathomUrl(u), u).toBe(true);
    }
  });

  it("rejects non-fathom links", () => {
    for (const u of [
      "https://fathom.video.evil.com/share/x",
      "https://notfathom.video/share/x",
      "https://example.com/share/abc",
      "https://youtube.com/watch?v=dQw4w9WgXcQ",
      "not a url",
      "",
    ]) {
      expect(isFathomUrl(u), u).toBe(false);
    }
  });
});

describe("socialCaption (best-effort text from a login-walled page)", () => {
  it("takes the longest of og:/twitter: description and embedded caption", () => {
    const html = `<meta property="og:description" content="12 likes - user on Instagram">
      <meta name="twitter:description" content="A short twitter blurb.">
      <script>{"edge_media_to_caption":{"edges":[{"node":{"text":"The full reel caption \\u2014 with details, line one, and a good deal more text so it is clearly the longest candidate.\\nLine two of the caption here."}}]}}</script>`;
    const cap = socialCaption(html);
    // The embedded caption is the longest candidate; entities/escapes are decoded.
    expect(cap).toContain("The full reel caption — with details");
    expect(cap).toContain("Line two of the caption here.");
  });

  it("returns null when there is nothing usable", () => {
    expect(socialCaption("<html><body>login</body></html>")).toBeNull();
  });
});

describe("kindOfFile (dispatch by extension, then MIME)", () => {
  it("dispatches by extension", () => {
    expect(kindOfFile("report.pdf")).toBe("pdf");
    expect(kindOfFile("notes.md")).toBe("text");
    expect(kindOfFile("data.CSV")).toBe("text");
    expect(kindOfFile("config.json")).toBe("text");
    expect(kindOfFile("voice-note.m4a")).toBe("audio");
    expect(kindOfFile("CALL.MP3")).toBe("audio");
    expect(kindOfFile("recording.mp4")).toBe("audio");
    expect(kindOfFile("screen.png")).toBe("image");
    expect(kindOfFile("photo.JPG")).toBe("image");
    expect(kindOfFile("C:\\Users\\me\\Desktop\\deck.pdf")).toBe("pdf");
  });

  it("the extension wins over a misleading MIME type", () => {
    expect(kindOfFile("notes.md", "application/octet-stream")).toBe("text");
    expect(kindOfFile("memo.m4a", "application/octet-stream")).toBe("audio");
  });

  it("falls back to the MIME type when there is no usable extension", () => {
    expect(kindOfFile("blob", "application/pdf")).toBe("pdf");
    expect(kindOfFile("blob", "audio/mpeg")).toBe("audio");
    expect(kindOfFile("blob", "video/webm")).toBe("audio");
    expect(kindOfFile("blob", "image/webp")).toBe("image");
    expect(kindOfFile("blob", "text/plain; charset=utf-8")).toBe("text");
    expect(kindOfFile("blob", "application/json")).toBe("text");
  });

  it("returns null for unsupported types", () => {
    expect(kindOfFile("deck.pptx")).toBeNull();
    expect(kindOfFile("doc.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBeNull();
    expect(kindOfFile("setup.exe", "application/x-msdownload")).toBeNull();
    expect(kindOfFile("", "")).toBeNull();
  });
});

describe("HTML → text", () => {
  const page = `<!doctype html><html><head><title>Fallback &amp; Title</title>
    <meta property="og:title" content="The &quot;Real&quot; Title" />
    <style>.x{color:red}</style><script>window.__DATA__=[1,2,3]</script></head>
    <body>
      <header><nav><a href="/">Home</a> <a href="/about">About</a></nav></header>
      <main>
        <article>
          <h1>Heading</h1>
          <p>First   paragraph with an &mdash; entity &amp; a &#39;quote&#39;.</p>
          <ul><li>Alpha</li><li>Beta</li></ul>
          <noscript>Enable JS</noscript>
          <p>${"Body text. ".repeat(30)}</p>
        </article>
      </main>
      <footer>© 2026 Footer text</footer>
      <script>trackEverything()</script>
    </body></html>`;

  it("keeps the article, drops chrome/scripts/styles, decodes entities, collapses whitespace", () => {
    const text = htmlToText(page);
    expect(text).toContain("Heading");
    expect(text).toContain("First paragraph with an — entity & a 'quote'.");
    expect(text).toContain("- Alpha");
    expect(text).toContain("- Beta");
    expect(text).not.toContain("Home");
    expect(text).not.toContain("Footer text");
    expect(text).not.toContain("trackEverything");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("Enable JS");
    expect(text).not.toMatch(/ {2,}/);
    expect(text).not.toMatch(/\n{3,}/);
    expect(text).not.toMatch(/<[a-z]+/i);
  });

  it("falls through to <main> when the <article> is only a stub", () => {
    const html = `<body><article><p>Tiny card</p></article><main><p>${"Real content here. ".repeat(20)}</p></main></body>`;
    const text = htmlToText(html);
    expect(text).toContain("Real content here.");
  });

  it("uses og:title before <title> and decodes it", () => {
    expect(htmlTitle(page)).toBe('The "Real" Title');
    expect(htmlTitle("<html><head><title>  Just &lt;a&gt;\n title </title></head></html>")).toBe("Just <a> title");
    expect(htmlTitle("<html><body>no title</body></html>")).toBeNull();
  });

  it("decodes numeric and named entities", () => {
    expect(decodeEntities("&#x27;hi&#39; &hellip; &nbsp;&copy;")).toBe("'hi' …  ©");
    expect(stripHtml("<p>a<br>b</p>")).toBe("a\nb");
  });

  it("maps hostnames to the taxonomy platform", () => {
    expect(platformOfHost("www.linkedin.com")).toBe("linkedin");
    expect(platformOfHost("lnkd.in")).toBe("linkedin");
    expect(platformOfHost("instagram.com")).toBe("instagram");
    expect(platformOfHost("x.com")).toBe("x");
    expect(platformOfHost("twitter.com")).toBe("x");
    expect(platformOfHost("m.facebook.com")).toBe("facebook");
    expect(platformOfHost("www.tiktok.com")).toBe("tiktok");
    expect(platformOfHost("youtu.be")).toBe("youtube");
    expect(platformOfHost("podcasts.apple.com")).toBe("podcast");
    expect(platformOfHost("open.spotify.com")).toBe("podcast");
    expect(platformOfHost("blog.example.com")).toBe("website");
  });
});

describe("capText (60k cap)", () => {
  it("leaves short text alone", () => {
    const r = capText("hello");
    expect(r).toEqual({ text: "hello", truncated: false });
  });

  it("cuts long text at a line break and notes the truncation", () => {
    const line = "x".repeat(99) + "\n";
    const long = line.repeat(1000); // 100k chars
    const r = capText(long);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThan(MAX_TEXT_CHARS + 200);
    expect(r.text).toMatch(/\[… truncated to 60,000 characters — the source was 100,000\]$/);
    // Cut on a line boundary: the body before the note is whole lines of x.
    const body = r.text.slice(0, r.text.indexOf("\n\n[…"));
    expect(body.split("\n").every((l) => l === "x".repeat(99))).toBe(true);
  });

  it("does not cut far back when there is no line break near the limit", () => {
    const r = capText("y".repeat(70_000));
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("y".repeat(MAX_TEXT_CHARS))).toBe(true);
  });
});

describe("YouTube page parsing", () => {
  const html = `<html><head><meta name="title" content="Meta Title"></head><body><script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"abc","title":"How to lead","lengthSeconds":"754","author":"Some Creator","shortDescription":"Line one\\nLine two"},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=abc\\u0026lang=en\\u0026kind=asr","name":{"simpleText":"English (auto-generated) [asr]"},"languageCode":"en","kind":"asr"},{"baseUrl":"https://www.youtube.com/api/timedtext?v=abc\\u0026lang=de","name":{"simpleText":"Deutsch"},"languageCode":"de"},{"baseUrl":"https://www.youtube.com/api/timedtext?v=abc\\u0026lang=en","name":{"simpleText":"English"},"languageCode":"en"}]}}};</script></body></html>`;

  it("readJsonValue balances brackets and ignores brackets inside strings", () => {
    const src = 'x = {"a":[1,{"b":"]}"}],"c":"\\"q\\""} rest';
    const raw = readJsonValue(src, src.indexOf("{"));
    expect(raw).toBe('{"a":[1,{"b":"]}"}],"c":"\\"q\\""}');
    expect(JSON.parse(raw!)).toEqual({ a: [1, { b: "]}" }], c: '"q"' });
    expect(readJsonValue("abc", 0)).toBeNull();
  });

  it("parses caption tracks with decoded baseUrls", () => {
    const tracks = parseCaptionTracks(html);
    expect(tracks).toHaveLength(3);
    expect(tracks[0].baseUrl).toBe("https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr");
    expect(tracks[0].kind).toBe("asr");
    expect(tracks[0].name).toBe("English (auto-generated) [asr]");
    expect(parseCaptionTracks("<html>no captions</html>")).toEqual([]);
  });

  it("prefers a human English track, then auto English, then any human track", () => {
    const tracks = parseCaptionTracks(html);
    expect(pickCaptionTrack(tracks)?.baseUrl).toMatch(/lang=en$/);
    expect(pickCaptionTrack(tracks.slice(0, 2))?.kind).toBe("asr");
    expect(pickCaptionTrack([tracks[1]])?.languageCode).toBe("de");
    expect(pickCaptionTrack([])).toBeNull();
  });

  it("reads the video details", () => {
    const d = parseVideoDetails(html);
    expect(d.title).toBe("How to lead");
    expect(d.author).toBe("Some Creator");
    expect(d.lengthSeconds).toBe(754);
    expect(d.description).toBe("Line one\nLine two");
    expect(parseVideoDetails('<meta name="title" content="Only &amp; Meta">').title).toBe("Only & Meta");
  });

  it("parses json3 and XML caption formats and joins them into paragraphs", () => {
    const json3 = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: "Hello " }, { utf8: "there." }] },
        { tStartMs: 1500, dDurationMs: 100, segs: [{ utf8: "\n" }] },
        { tStartMs: 1600, dDurationMs: 1000, segs: [{ utf8: "Same paragraph." }] },
        { tStartMs: 9000, dDurationMs: 1000, segs: [{ utf8: "After a long pause." }] },
      ],
    });
    const segs = parseJson3(json3);
    expect(segs).toHaveLength(3);
    expect(segmentsToParagraphs(segs)).toBe("Hello there. Same paragraph.\n\nAfter a long pause.");
    expect(parseJson3("not json")).toEqual([]);

    const xml = `<?xml version="1.0"?><transcript><text start="0" dur="1.5">I&amp;#39;m here &amp;amp; ready</text><text start="1.5" dur="1">next</text></transcript>`;
    const xsegs = parseTimedTextXml(xml);
    expect(xsegs).toEqual([
      { t: 0, d: 1500, text: "I'm here & ready" },
      { t: 1500, d: 1000, text: "next" },
    ]);
  });

  it("parses the srv3 format the Android client serves (<p t d> with <s> word children)", () => {
    const srv3 = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><head><wp id="0"/></head><body><p t="13240" d="2560">A few years ago, I broke into</p><p t="15800" d="100" a="1">\n</p><p t="16000" d="2000"><s ac="252">my</s><s t="300" ac="200"> own</s><s t="600"> house&#39;s</s></p></body></timedtext>`;
    expect(parseTimedTextXml(srv3)).toEqual([
      { t: 13240, d: 2560, text: "A few years ago, I broke into" },
      { t: 16000, d: 2000, text: "my own house's" },
    ]);
    // parseTimedText auto-detects json3 vs XML.
    expect(parseTimedText(`  ${srv3}`)).toHaveLength(2);
    expect(parseTimedText(JSON.stringify({ events: [{ tStartMs: 1, dDurationMs: 2, segs: [{ utf8: "hi" }] }] }))).toEqual([{ t: 1, d: 2, text: "hi" }]);
    expect(parseTimedText("")).toEqual([]);
  });
});

describe("extractAny (files, no network)", () => {
  it("decodes a UTF-8 text file (BOM stripped, CRLF normalised)", async () => {
    const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Notes\r\nline two — ünïcode", "utf-8")]);
    const r = await extractAny({ file: { name: "notes.md", mime: "text/markdown", buffer } });
    expect(r.kind).toBe("text");
    expect(r.name).toBe("notes.md");
    expect(r.text).toBe("# Notes\nline two — ünïcode");
    expect(r.chars).toBe(r.text.length);
    expect(r.truncated).toBe(false);
    expect(r.meta.source_type).toBe("text");
  });

  it("caps the returned text at 60k characters", async () => {
    const buffer = Buffer.from(("z".repeat(80) + "\n").repeat(1000));
    const r = await extractAny({ file: { name: "big.txt", mime: "text/plain", buffer } });
    expect(r.truncated).toBe(true);
    expect(r.chars).toBeLessThan(MAX_TEXT_CHARS + 200);
    expect(r.text).toContain("truncated to 60,000 characters");
  });

  it("rejects unsupported files, empty files and empty input with a readable status", async () => {
    await expect(extractAny({ file: { name: "deck.pptx", mime: "", buffer: Buffer.from("x") } })).rejects.toMatchObject({ status: 415 });
    await expect(extractAny({ file: { name: "empty.txt", mime: "text/plain", buffer: Buffer.alloc(0) } })).rejects.toMatchObject({ status: 400 });
    await expect(extractAny({})).rejects.toBeInstanceOf(ExtractError);
  });

  it("refuses a link that is not http(s) before any network call", async () => {
    await expect(extractAny({ url: "ftp://example.com/file.txt" })).rejects.toMatchObject({ status: 400 });
  });

  it("routes a fathom.video link to the fathom adapter (before the generic url adapter)", async () => {
    const url = "https://fathom.video/share/abc123";
    const r = await extractAny({ url });
    expect(vi.mocked(extractFathom)).toHaveBeenCalledWith(url);
    expect(r.kind).toBe("url");
    expect(r.title).toBe("Impromptu Zoom Meeting");
    expect(r.meta.source_type).toBe("call");
    expect(r.meta.source_platform).toBe("fathom");
    expect(r.text).toContain("CALL TRANSCRIPT");
  });
});
