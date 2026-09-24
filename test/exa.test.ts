import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getProviderKey } from "@/lib/secrets";
import { exaContents, tryExaContents, parseExaContents, redactSecret, ExaError, EXA_MAX_CHARACTERS } from "@/lib/ingest-adapters/exa";
import { extractFromYouTube, blockToParagraphs, youTubeExaFirst, exaYouTubeTranscript } from "@/lib/ingest-adapters/youtube";
import { extractFromUrl, isUsefulSocialText, isUsefulPageText, socialPlatformOfUrl, LOGIN_WALL_MESSAGE } from "@/lib/ingest-adapters/url";

// No network: global fetch is replaced by a URL router, the SSRF guard's DNS
// lookup is stubbed, and the key store answers a FAKE key.
vi.mock("@/lib/net-guard", async (orig) => ({ ...(await orig<typeof import("@/lib/net-guard")>()), assertPublicUrl: vi.fn(async () => {}) }));
vi.mock("@/lib/secrets", () => ({ getProviderKey: vi.fn() }));

const FAKE_KEY = "exa-test-FAKE-key-0123456789abcdef";
const VIDEO_ID = "dQw4w9WgXcQ";
const WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
let routes: [(url: string) => boolean, Handler][] = [];
let calls: { url: string; init: RequestInit }[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const route = (match: string | RegExp | ((url: string) => boolean), h: Handler) =>
  routes.push([(u) => (typeof match === "string" ? u.includes(match) : typeof match === "function" ? match(u) : match.test(u)), h]);
const isExa = (u: string) => u.startsWith("https://api.exa.ai/");
const exaCalls = () => calls.filter((c) => isExa(c.url));
const exaOk = (text: string, extra: Record<string, unknown> = {}) =>
  json({ requestId: "r1", results: [{ id: "x", url: WATCH_URL, title: "Exa Title", author: "Exa Channel", text, ...extra }], statuses: [{ id: "x", status: "success", source: "cached" }] });

const TRANSCRIPT = "Hello and welcome to the talk. " + "This sentence is part of a long transcript about building things. ".repeat(40);
// Longer than any YouTube description can be (5,000 chars), so it is labelled a transcript even with no description to compare.
const LONG_TRANSCRIPT = "Hello and welcome to the talk. " + "This sentence is part of a long transcript about building things. ".repeat(90);

beforeEach(() => {
  routes = [];
  calls = [];
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("VERCEL_REGION", "");
  vi.mocked(getProviderKey).mockReset().mockResolvedValue(FAKE_KEY);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init });
      const hit = routes.find(([m]) => m(url));
      if (!hit) throw new TypeError(`unrouted fetch in test: ${url}`);
      return hit[1](url, init);
    })
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Every string an ExaError exposes (message, detail, the thrown text). */
async function errorText(p: Promise<unknown>): Promise<{ err: ExaError; all: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as ExaError;
    return { err, all: [err.message, err.detail ?? "", String(err)].join(" | ") };
  }
  throw new Error("expected a rejection");
}

describe("exaContents", () => {
  it("returns null without a request when no key is configured", async () => {
    vi.mocked(getProviderKey).mockResolvedValue(undefined);
    expect(await exaContents(WATCH_URL)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("POSTs the url with the key header, the clamped char cap and livecrawl=fallback, and parses results[0]", async () => {
    route(isExa, () => exaOk("  the text  ", { publishedDate: "2024-01-01T00:00:00.000Z" }));
    const page = await exaContents(WATCH_URL);
    expect(page).toEqual({ url: WATCH_URL, title: "Exa Title", text: "the text", author: "Exa Channel", publishedDate: "2024-01-01T00:00:00.000Z" });
    const [call] = exaCalls();
    expect(call.url).toBe("https://api.exa.ai/contents");
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>)["x-api-key"]).toBe(FAKE_KEY);
    expect(call.init.redirect).toBe("manual");
    const body = JSON.parse(String(call.init.body));
    expect(body).toEqual({ urls: [WATCH_URL], text: { maxCharacters: EXA_MAX_CHARACTERS }, livecrawl: "fallback" });
  });

  it.each([
    [401, "auth", 502],
    [403, "auth", 502],
    [402, "quota", 502],
    [429, "rate_limit", 429],
    [400, "bad_request", 422],
    [500, "upstream", 502],
    [503, "upstream", 502],
  ])("maps HTTP %i to code %s (status %i) without leaking the key", async (http, code, status) => {
    // The upstream body echoes the key — it must be redacted everywhere.
    route(isExa, () => json({ error: `bad key ${FAKE_KEY} for request`, tag: "INVALID_API_KEY" }, http));
    const { err, all } = await errorText(exaContents(WATCH_URL));
    expect(err).toBeInstanceOf(ExaError);
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(all).not.toContain(FAKE_KEY);
    expect(err.detail).toContain("[redacted]");
  });

  it("maps empty text and a per-url crawl error", async () => {
    route(isExa, () => exaOk("   \n  "));
    expect((await errorText(exaContents(WATCH_URL))).err.code).toBe("empty");

    routes = [];
    route(isExa, () => json({ results: [], statuses: [{ id: "x", status: "error", error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 } }] }));
    const { err } = await errorText(exaContents(WATCH_URL));
    expect(err.code).toBe("unavailable");
    expect(err.message).toContain("CRAWL_NOT_FOUND");
  });

  it("redacts the key from a network failure and from the log line of tryExaContents", async () => {
    route(isExa, () => {
      throw new TypeError(`connect failed while sending x-api-key=${FAKE_KEY}`);
    });
    const { err, all } = await errorText(exaContents(WATCH_URL));
    expect(err.code).toBe("network");
    expect(all).not.toContain(FAKE_KEY);

    const warn = vi.mocked(console.warn);
    warn.mockClear();
    expect(await tryExaContents(WATCH_URL, "test")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(" ")).not.toContain(FAKE_KEY);
  });

  it("parses defensively and redacts", () => {
    expect(() => parseExaContents("not json", WATCH_URL)).toThrow(ExaError);
    expect(parseExaContents(JSON.stringify({ results: [{ text: "x\r\n\n\n\ny" }] }), WATCH_URL)).toMatchObject({ url: WATCH_URL, title: null, text: "x\n\ny", author: null });
    expect(redactSecret(`a ${FAKE_KEY} b ${FAKE_KEY}`, FAKE_KEY)).toBe("a [redacted] b [redacted]");
    expect(redactSecret("unchanged", undefined)).toBe("unchanged");
  });
});

describe("blockToParagraphs", () => {
  it("splits one block on sentence ends past the target, and unpunctuated text at twice the target", () => {
    const out = blockToParagraphs(TRANSCRIPT);
    const paras = out.split("\n\n");
    expect(paras.length).toBeGreaterThan(3);
    for (const p of paras.slice(0, -1)) {
      expect(p.length).toBeGreaterThanOrEqual(600);
      expect(p).toMatch(/\.$/);
    }
    const bare = blockToParagraphs("word ".repeat(600));
    expect(Math.max(...bare.split("\n\n").map((p) => p.length))).toBeLessThanOrEqual(1205);
  });

  it("keeps text that already has paragraphs", () => {
    expect(blockToParagraphs("one.\n\ntwo.")).toBe("one.\n\ntwo.");
  });
});

// Shaped like a stale Exa cache entry of a watch page: the title line and YouTube's footer, no speech.
const YT_SHELL =
  "Some Talk | Some Speaker | Some Org - YouTube\n\nAbout Press Copyright Contact us Creators Advertise Developers Cancel Memberships Terms Privacy Policy & Safety How YouTube works Test new features";

describe("exaYouTubeTranscript", () => {
  it("drops YouTube chrome lines and keeps the (long, single-line) transcript", () => {
    expect(exaYouTubeTranscript(YT_SHELL)).toBe("");
    expect(exaYouTubeTranscript(`${TRANSCRIPT}\n\n${YT_SHELL}`)).toBe(TRANSCRIPT.trim());
    // A spoken "not a bot" inside the transcript line is never mistaken for the wall.
    const spoken = `${TRANSCRIPT} I promise I am not a bot. ${TRANSCRIPT}`;
    expect(exaYouTubeTranscript(spoken)).toBe(spoken.trim());
  });
});

// ---- YouTube dispatch ------------------------------------------------------

const TRACK = { baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=en`, languageCode: "en" };

function nativeWorks() {
  route("/youtubei/v1/player", () =>
    json({ playabilityStatus: { status: "OK" }, videoDetails: { title: "Native Title", author: "Native Channel", lengthSeconds: "90" }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [TRACK] } } })
  );
  route("/api/timedtext", () => json({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "native caption line" }] }] }));
  route("/oembed", () => json({ title: "Native Title", author_name: "Native Channel" }));
}

function nativeBotWalled() {
  route("/youtubei/v1/player", () => json({ playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" } }));
  route("/watch?v=", () => html("Too many requests", 429));
  route("/oembed", () => json({}, 401));
}

describe("extractFromYouTube dispatch", () => {
  it("reads the Vercel flag", () => {
    expect(youTubeExaFirst()).toBe(false);
    vi.stubEnv("VERCEL", "1");
    expect(youTubeExaFirst()).toBe(true);
  });

  it("off Vercel: native first — Exa is never called when captions are read", async () => {
    nativeWorks();
    route(isExa, () => exaOk(TRANSCRIPT));
    const r = await extractFromYouTube(WATCH_URL);
    expect(r.text).toContain("Transcript from captions (en)");
    expect(r.text).toContain("native caption line");
    expect(exaCalls()).toHaveLength(0);
  });

  it("off Vercel: the bot wall falls through to Exa, in the native result's shape", async () => {
    nativeBotWalled();
    route(isExa, () => exaOk(LONG_TRANSCRIPT, { title: "Exa Title - YouTube" }));
    const r = await extractFromYouTube(WATCH_URL);
    expect(r.title).toBe("Exa Title");
    expect(r.text.startsWith("# Exa Title\nby Exa Channel · YouTube\nTranscript (via Exa):\n\n")).toBe(true);
    expect(r.meta).toEqual({ source_type: "video", source_platform: "youtube", source_url: WATCH_URL });
    expect(calls[0].url).toContain("youtube.com"); // native went first
    expect(isExa(calls[calls.length - 1].url)).toBe(true);
    expect(exaCalls()).toHaveLength(1);
  });

  it("off Vercel: when Exa fails too, the honest native 422 stands (and names no key)", async () => {
    nativeBotWalled();
    route(isExa, () => json({ error: `limit for ${FAKE_KEY}` }, 429));
    const err = (await extractFromYouTube(WATCH_URL).catch((e) => e)) as Error & { status: number };
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/blocking automated transcript access/);
    expect(err.message).not.toContain(FAKE_KEY);
  });

  it("on Vercel: Exa first — the native chain is never touched when Exa answers", async () => {
    vi.stubEnv("VERCEL", "1");
    nativeWorks();
    route(isExa, () => exaOk(LONG_TRANSCRIPT));
    const r = await extractFromYouTube(WATCH_URL);
    expect(r.text).toContain("Transcript (via Exa)");
    expect(calls).toHaveLength(1);
    expect(isExa(calls[0].url)).toBe(true);
  });

  it("YouTube reads ask Exa for a fresh crawl (livecrawl=preferred)", async () => {
    vi.stubEnv("VERCEL", "1");
    route(isExa, () => exaOk(TRANSCRIPT));
    await extractFromYouTube(WATCH_URL);
    expect(JSON.parse(String(exaCalls()[0].init.body)).livecrawl).toBe("preferred");
  });

  it("on Vercel: a chrome-only Exa read (stale cache: title line + footer) falls back to the native chain", async () => {
    vi.stubEnv("VERCEL", "1");
    nativeWorks();
    route(isExa, () => exaOk(YT_SHELL, { title: "" }));
    const r = await extractFromYouTube(WATCH_URL);
    expect(exaCalls()).toHaveLength(1);
    expect(r.text).toContain("Transcript from captions (en)");
  });

  it("on Vercel: an empty Exa read falls back to the native chain", async () => {
    vi.stubEnv("VERCEL", "1");
    nativeWorks();
    route(isExa, () => exaOk(""));
    const r = await extractFromYouTube(WATCH_URL);
    expect(isExa(calls[0].url)).toBe(true);
    expect(r.text).toContain("Transcript from captions (en)");
  });

  it("on Vercel without a key: straight to the native chain (no Exa request)", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.mocked(getProviderKey).mockResolvedValue(undefined);
    nativeWorks();
    const r = await extractFromYouTube(WATCH_URL);
    expect(r.text).toContain("Transcript from captions (en)");
    expect(exaCalls()).toHaveLength(0);
  });

  it("description-only native result: Exa is asked, but a read that is just the description is ignored", async () => {
    const description = "This is the video description with links and a summary of what is inside the video. ".repeat(3);
    route("/youtubei/v1/player", () => json({ playabilityStatus: { status: "OK" }, videoDetails: { title: "No Caps", author: "C", shortDescription: description } }));
    route("/watch?v=", () => html("<html></html>"));
    route("/oembed", () => json({ title: "No Caps", author_name: "C" }));
    route(isExa, () => exaOk(description));
    const r = await extractFromYouTube(WATCH_URL);
    expect(exaCalls()).toHaveLength(1);
    expect(r.text).toContain("(no captions available — description only)");
  });

  it("on Vercel: a caption-less video's Exa read (just the description) is never labelled a transcript", async () => {
    vi.stubEnv("VERCEL", "1");
    const description = "This is the video description with links and a summary of what is inside the video. ".repeat(3);
    route("/youtubei/v1/player", () => json({ playabilityStatus: { status: "OK" }, videoDetails: { title: "No Caps", author: "C", shortDescription: description } }));
    route("/watch?v=", () => html("<html></html>"));
    route("/oembed", () => json({ title: "No Caps", author_name: "C" }));
    route(isExa, () => exaOk(description, { title: "No Caps", author: "C" }));
    const r = await extractFromYouTube(WATCH_URL);
    expect(r.text).not.toContain("Transcript (via Exa)");
    expect(r.text).toContain("may be the description, not a transcript");
  });

  it("off Vercel: a short Exa read after the bot wall (no description to compare) is not labelled a transcript", async () => {
    nativeBotWalled();
    route(isExa, () => exaOk(TRANSCRIPT));
    const r = await extractFromYouTube(WATCH_URL);
    expect(r.text).not.toContain("Transcript (via Exa)");
    expect(r.text).toContain("Text from the video page (via Exa; may be the description, not a transcript):");
  });
});

// ---- social + generic pages ------------------------------------------------

const IG_URL = "https://www.instagram.com/reel/AbCdEfGhIjK/";
// Synthetic, shaped like Exa's read of a walled reel: bare brand title, handles, "Like", one stray comment, a date.
const IG_SHELL_TEXT = "Instagram\n\nsomeaccount\n\nuser_one\n\nLike\n\nanother.user\n\nWhat a great idea, I hope they really get to Mars one day, fingers crossed\n\nLike\n\nuser_three\n\nJuly 27, 2023";
const IG_CAPTION =
  "Our new streaming service launches this fall. Watch live coverage of launches, documentaries and behind-the-scenes series, all ad-free, right in the app you already use.";
const IG_LOGIN_HTML = "<html><head><title>Instagram</title></head><body><div>Log in to see photos and videos from friends.</div></body></html>";

describe("social links via Exa", () => {
  it("classifies social links by host, leaving shorteners to the redirect", () => {
    expect(socialPlatformOfUrl(IG_URL)).toBe("instagram");
    expect(socialPlatformOfUrl("https://www.threads.net/@a/post/xyz")).toBe("threads");
    expect(socialPlatformOfUrl("https://t.co/abc")).toBeNull();
    expect(socialPlatformOfUrl("https://example.com/")).toBeNull();
  });

  it("rejects a login shell and accepts post text", () => {
    expect(isUsefulSocialText({ title: "Instagram", text: IG_SHELL_TEXT })).toBe(false);
    expect(isUsefulSocialText({ title: null, text: "Log in to see this post and more from people you follow on Instagram. Sign up to continue. ".repeat(2) })).toBe(false);
    expect(isUsefulSocialText({ title: 'Space Agency on Instagram: "Our new streaming service"', text: `spaceagency\n\n${IG_CAPTION}\n\n12.4K likes` })).toBe(true);
    expect(isUsefulPageText("Please enable JavaScript to use this app.")).toBe(false);
    expect(isUsefulPageText("Real article text. ".repeat(20))).toBe(true);
  });

  it("returns Exa's text when it is the post", async () => {
    route(isExa, () => json({ results: [{ url: IG_URL, title: 'Space Agency on Instagram: "Our new streaming service"', text: `spaceagency\n\n${IG_CAPTION}` }] }));
    route("instagram.com", () => html(IG_LOGIN_HTML));
    const r = await extractFromUrl(IG_URL);
    expect(r.text).toContain(IG_CAPTION);
    expect(r.meta).toEqual({ source_type: "text", source_platform: "instagram", source_url: IG_URL });
  });

  it("keeps today's honest 422 when Exa only sees the login shell and the page has no caption", async () => {
    route(isExa, () => json({ results: [{ url: IG_URL, title: "Instagram", text: IG_SHELL_TEXT }] }));
    route("instagram.com", () => html(IG_LOGIN_HTML));
    await expect(extractFromUrl(IG_URL)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("Instagram doesn't expose this reel's text") });
    expect(exaCalls()).toHaveLength(1);
  });

  it("falls back to the scraped og:description caption when Exa has nothing useful", async () => {
    route(isExa, () => json({ error: "rate limited" }, 429));
    route("instagram.com", () => html(`<html><head><title>Instagram</title><meta property="og:description" content="${IG_CAPTION}"></head><body></body></html>`));
    const r = await extractFromUrl(IG_URL);
    expect(r.text).toContain(IG_CAPTION);
  });
});

describe("generic pages: Exa when the direct fetch can't read them", () => {
  const PAGE = "https://example.com/article";
  const ARTICLE = "An article paragraph with real content in it. ".repeat(20);

  it("a 403 is read through Exa", async () => {
    route("example.com", () => html("Forbidden", 403));
    route(isExa, () => json({ results: [{ url: PAGE, title: "The Article", text: ARTICLE }] }));
    const r = await extractFromUrl(PAGE);
    expect(r.title).toBe("The Article");
    expect(r.text.startsWith("# The Article\n\n")).toBe(true);
    expect(r.meta).toEqual({ source_type: "text", source_platform: "website", source_url: PAGE });
  });

  it("a JS-only shell is read through Exa (the page's own title as the fallback)", async () => {
    route("example.com", () => html('<html><head><title>Shell App</title></head><body><div id="root"></div></body></html>'));
    route(isExa, () => json({ results: [{ url: PAGE, text: ARTICLE }] }));
    const r = await extractFromUrl(PAGE);
    expect(r.title).toBe("Shell App");
    expect(r.text).toContain("An article paragraph");
  });

  it("without a key the direct-fetch message stands", async () => {
    vi.mocked(getProviderKey).mockResolvedValue(undefined);
    route("example.com", () => html("Forbidden", 403));
    await expect(extractFromUrl(PAGE)).rejects.toMatchObject({ status: 422, message: LOGIN_WALL_MESSAGE });
    expect(exaCalls()).toHaveLength(0);
  });

  it("a readable page and a 404 never call Exa", async () => {
    route("example.com/article", () => html(`<html><head><title>T</title></head><body><article>${ARTICLE}</article></body></html>`));
    route("example.com/missing", () => html("nope", 404));
    route(isExa, () => exaOk(ARTICLE));
    expect((await extractFromUrl(PAGE)).text).toContain("An article paragraph");
    await expect(extractFromUrl("https://example.com/missing")).rejects.toMatchObject({ status: 422 });
    expect(exaCalls()).toHaveLength(0);
  });
});
