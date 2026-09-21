import { describe, it, expect } from "vitest";
import {
  headingCandidates,
  looksLikeHeading,
  outlineCandidates,
  chaptersFromOutline,
  splitByOutline,
  fallbackChapters,
  proseChars,
  sourceKey,
  isGenericSectionTitle,
  baseSectionTitle,
  FRONT_MATTER_TITLE,
  MIN_SECTION_CHARS,
  MAX_SECTION_CHARS,
  MAX_OUTLINE_CANDIDATES,
  type LongSection,
} from "@/lib/long-source-pure";

// Pure parts only — no model call, no network.

const SENTENCE = "Here is a number that should make every business owner a little uncomfortable today.";
/** ~n chars of prose, wrapped like PDF text (one sentence per line). */
function prose(n: number): string {
  const lines: string[] = [];
  let len = 0;
  while (len < n) {
    lines.push(SENTENCE);
    len += SENTENCE.length + 1;
  }
  return lines.join("\n");
}
/** A chapter the way the book's PDF text reads: title, epigraph, blank, sub-heading, blank, body. */
function chapter(title: string, chars: number, sub = "The Number That Should Make You Uncomfortable"): string {
  return `${title}\n*"An epigraph."* — SOMEONE\n\n${sub}\n\n${prose(chars)}`;
}

function expectContiguous(text: string, sections: LongSection[]) {
  expect(sections.length).toBeGreaterThan(0);
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    expect(s.index).toBe(i);
    expect(s.text).toBe(text.slice(s.start, s.end));
    expect(s.chars).toBe(s.end - s.start);
    if (i > 0) expect(s.start).toBe(sections[i - 1].end);
  }
  expect(sections[sections.length - 1].end).toBe(text.length);
}

describe("headingCandidates", () => {
  it("accepts short Title-Case lines after a blank line, with exact offsets", () => {
    const text = `Cover\n\n${chapter("The Show Bonus", 300)}\n\n${chapter("The 99% DM Messenger Close", 300, "Why Most DM Outreach Fails")}\n\nTHE MOST EXPENSIVE WORD\n\n${prose(100)}`;
    const c = headingCandidates(text);
    expect(c.map((x) => x.text)).toEqual([
      "Cover",
      "The Show Bonus",
      "The Number That Should Make You Uncomfortable",
      "The 99% DM Messenger Close",
      "Why Most DM Outreach Fails",
      "THE MOST EXPENSIVE WORD",
    ]);
    for (const x of c) expect(text.slice(x.offset).startsWith(x.text)).toBe(true);
    expect(c[1].line).toBe(2);
  });

  it("rejects sentences, terminal punctuation, long lines, lowercase lines and lines inside a paragraph", () => {
    for (const bad of [
      "This is simply a sentence that happens to be short",
      "The Show Bonus.",
      "What Is a No-Show?",
      "Step One:",
      "The Show Bonus,",
      "A Very Long Heading That Keeps Going And Going Until It Is Well Past Seventy Characters Wide",
      "One Two Three Four Five Six Seven Eight Nine Ten Eleven",
      "the show bonus",
      "Abc",
      "12",
    ]) {
      expect(looksLikeHeading(bad), bad).toBe(false);
      expect(headingCandidates(`${prose(100)}\n\n${bad}\n\n${prose(100)}`), bad).toEqual([]);
    }
    // Title Case, but not preceded by a blank line → part of the paragraph.
    expect(headingCandidates(`${SENTENCE}\nThe Show Bonus\n${SENTENCE}`)).toEqual([]);
  });

  it("ignores minor words and non-letter tokens when scoring capitalisation", () => {
    for (const ok of ["The Five Stages of Awareness", "The Bribe & Bonus System", "How to Read This Book", "A Note on the Bonus Chapters", "Hyper-Care", "The Buyer's Journey Map", "Chapter 7"]) {
      expect(looksLikeHeading(ok), ok).toBe(true);
    }
    expect(looksLikeHeading("of the and")).toBe(false);
  });

  it("strips markdown heading marks, emphasis and quotes; a # heading needs no blank line", () => {
    const text = `${SENTENCE}\n## The Town Hall\n${SENTENCE}\n\n**Authority Assets**\n\n"The Wow Document"\n\n${SENTENCE}`;
    expect(headingCandidates(text).map((c) => c.text)).toEqual(["The Town Hall", "Authority Assets", "The Wow Document"]);
  });

  it("handles CRLF text without shifting offsets", () => {
    const text = `Intro line that is a full sentence, not a heading.\r\n\r\nThe Show Bonus\r\n\r\n${SENTENCE}`;
    const [c] = headingCandidates(text);
    expect(c.text).toBe("The Show Bonus");
    expect(text.slice(c.offset, c.offset + 14)).toBe("The Show Bonus");
  });
});

describe("outlineCandidates / chaptersFromOutline", () => {
  it("sends index + text + the next non-empty line — never the body", () => {
    const text = `${chapter("The Show Bonus", 200)}\n\n${chapter("Opener Optimisation", 200, "The First Message")}`;
    const cands = headingCandidates(text);
    const list = outlineCandidates(text, cands);
    expect(list.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    expect(list[0]).toEqual({ index: 0, text: "The Show Bonus", hint: '*"An epigraph."* — SOMEONE' });
    expect(list[1].hint).toBe(SENTENCE);
    expect(JSON.stringify(list).length).toBeLessThan(600);
  });

  it("thins an over-long list evenly to the cap, keeping original indexes", () => {
    const text = Array.from({ length: 1500 }, (_, i) => `Heading Number ${i}\n\n${SENTENCE}`).join("\n\n");
    const cands = headingCandidates(text);
    expect(cands.length).toBe(1500);
    const list = outlineCandidates(text, cands);
    expect(list.length).toBe(MAX_OUTLINE_CANDIDATES);
    expect(list[0].index).toBe(0);
    expect(new Set(list.map((c) => c.index)).size).toBe(MAX_OUTLINE_CANDIDATES);
    for (const c of list) expect(cands[c.index].text).toBe(c.text);
  });

  it("maps picks to offsets: reading order, unknown and repeated indexes dropped, empty title → the candidate's", () => {
    const text = `${chapter("The Show Bonus", 200)}\n\n${chapter("Opener Optimisation", 200, "The First Message")}`;
    const cands = headingCandidates(text);
    const chapters = chaptersFromOutline(cands, [
      { index: 2, title: "  Opener Optimisation " },
      { index: 0, title: "" },
      { index: 2, title: "again" },
      { index: 99, title: "ghost" },
      { index: 1.5, title: "fraction" },
    ]);
    expect(chapters).toEqual([
      { offset: cands[0].offset, title: "The Show Bonus" },
      { offset: cands[2].offset, title: "Opener Optimisation" },
    ]);
  });
});

describe("splitByOutline", () => {
  const titles = ["The Show Bonus", "Opener Optimisation", "Reopener Optimisation", "Authority Assets"];
  function book(front: string, sizes = [4000, 5000, 3000, 6000]) {
    const text = `${front}${titles.map((t, i) => chapter(t, sizes[i])).join("\n\n")}`;
    const cands = headingCandidates(text);
    const chapters = titles.map((t) => ({ offset: cands.find((c) => c.text === t)!.offset, title: t }));
    return { text, cands, chapters };
  }

  it("one section per chapter, contiguous and covering; preview skips the heading line", () => {
    const { text, chapters, cands } = book("");
    const s = splitByOutline(text, chapters, cands);
    expect(s.map((x) => x.title)).toEqual(titles);
    expectContiguous(text, s);
    expect(s[0].start).toBe(0);
    expect(s[0].preview.startsWith("The Show Bonus")).toBe(false);
    expect(s[0].preview.length).toBeLessThanOrEqual(221);
    expect(s[1].text.startsWith("Opener Optimisation")).toBe(true);
  });

  it("drops thin front matter (cover, table of contents) and keeps real prose as 'Front matter'", () => {
    const toc = `Cover\n\nContents\n\n${titles.join("\n")}\n\n`;
    expect(proseChars(toc)).toBe(0);
    const thin = book(toc);
    const a = splitByOutline(thin.text, thin.chapters, thin.cands);
    expect(a[0].title).toBe("The Show Bonus");
    expect(a[0].start).toBe(thin.chapters[0].offset);
    expectContiguous(thin.text, a);

    const real = book(`Cover\n\n${prose(MIN_SECTION_CHARS + 200)}\n\n`);
    const b = splitByOutline(real.text, real.chapters, real.cands);
    expect(b[0].title).toBe(FRONT_MATTER_TITLE);
    expect(b[0].start).toBe(0);
    expect(b[1].title).toBe("The Show Bonus");
    expectContiguous(real.text, b);
  });

  it("merges a section under 1,500 chars into the next one (which keeps its title); a small tail joins the previous", () => {
    const { text, chapters, cands } = book("", [4000, 300, 5000, 200]);
    const s = splitByOutline(text, chapters, cands);
    expect(s.map((x) => x.title)).toEqual(["The Show Bonus", "Reopener Optimisation"]);
    // The small "Opener Optimisation" rides at the head of the next section; the small tail at the end of it.
    expect(s[1].text.startsWith("Opener Optimisation")).toBe(true);
    expect(s[1].text).toContain("Authority Assets");
    for (const x of s) expect(x.chars).toBeGreaterThanOrEqual(MIN_SECTION_CHARS);
    expectContiguous(text, s);
  });

  it("sub-splits a section over 30,000 chars at heading candidates into '(part i/n)'", () => {
    const big = `The Monopoly Board\n*"Epigraph."* — X\n\n${["First Principles", "The Second Movement", "A Third Angle", "Closing the Loop"].map((h) => `${h}\n\n${prose(17_000)}`).join("\n\n")}`;
    const text = `${chapter("The Show Bonus", 4000)}\n\n${big}\n\n${chapter("Authority Assets", 4000)}`;
    const cands = headingCandidates(text);
    const at = (t: string) => cands.find((c) => c.text === t)!.offset;
    const s = splitByOutline(text, [{ offset: 0, title: "The Show Bonus" }, { offset: at("The Monopoly Board"), title: "The Monopoly Board" }, { offset: at("Authority Assets"), title: "Authority Assets" }], cands);
    const parts = s.filter((x) => x.title.startsWith("The Monopoly Board"));
    expect(parts.map((x) => x.title)).toEqual(["The Monopoly Board (part 1/3)", "The Monopoly Board (part 2/3)", "The Monopoly Board (part 3/3)"]);
    // Inner cuts land on heading candidates, never mid-paragraph.
    const offsets = new Set(cands.map((c) => c.offset));
    for (const p of parts.slice(1)) expect(offsets.has(p.start)).toBe(true);
    for (const p of parts) expect(p.chars).toBeLessThan(MAX_SECTION_CHARS * 1.4);
    expect(s[s.length - 1].title).toBe("Authority Assets");
    expectContiguous(text, s);
  });

  it("sub-splits at paragraph breaks when a huge section has no headings inside", () => {
    const text = `The Wall of Text\n\n${Array.from({ length: 40 }, () => prose(2000)).join("\n\n")}`;
    const s = splitByOutline(text, [{ offset: 0, title: "The Wall of Text" }]);
    expect(s.length).toBeGreaterThanOrEqual(3);
    for (const p of s.slice(1)) expect(text.slice(p.start - 2, p.start)).toBe("\n\n");
    expectContiguous(text, s);
  });

  it("is safe on odd input: no chapters, out-of-range and duplicate offsets, empty text", () => {
    const text = prose(5000);
    expect(splitByOutline("", [{ offset: 0, title: "x" }])).toEqual([]);
    const none = splitByOutline(text, []);
    expect(none).toHaveLength(1);
    expectContiguous(text, none);
    const odd = splitByOutline(text, [{ offset: -5, title: "neg" }, { offset: 0, title: "A" }, { offset: 0, title: "dupe" }, { offset: 2500, title: "B" }, { offset: 9_999_999, title: "far" }]);
    expect(odd.map((x) => x.title)).toEqual(["A", "B"]);
    expectContiguous(text, odd);
  });
});

describe("fallbackChapters (deterministic split by size)", () => {
  it("cuts ~14k-char parts at the nearest heading, titled 'Part N — <first heading inside>'", () => {
    const names = ["Alpha Principle", "Beta Method", "Gamma System", "Delta Model", "Epsilon Rule", "Zeta Frame"];
    const text = names.map((n) => chapter(n, 13_000, `${n} In Practice`)).join("\n\n");
    const cands = headingCandidates(text);
    const chapters = fallbackChapters(text, cands);
    expect(chapters.length).toBeGreaterThanOrEqual(5);
    expect(chapters[0]).toEqual({ offset: 0, title: "Part 1 — Alpha Principle" });
    const offsets = new Set(cands.map((c) => c.offset));
    for (const c of chapters.slice(1)) {
      expect(offsets.has(c.offset)).toBe(true);
      expect(c.title).toMatch(/^Part \d+ — /);
    }
    const s = splitByOutline(text, chapters, cands);
    expectContiguous(text, s);
    expect(s[0].start).toBe(0);
    for (const x of s) expect(x.chars).toBeLessThanOrEqual(MAX_SECTION_CHARS);
  });

  it("works with no headings at all, and on a short text", () => {
    const text = Array.from({ length: 30 }, () => prose(1500)).join("\n\n");
    const chapters = fallbackChapters(text);
    expect(chapters.length).toBeGreaterThan(1);
    expect(chapters.map((c) => c.title)).toEqual(chapters.map((_, i) => `Part ${i + 1}`));
    expectContiguous(text, splitByOutline(text, chapters));
    expect(fallbackChapters("short text")).toEqual([{ offset: 0, title: "Part 1" }]);
  });
});

describe("section titles and the resume key", () => {
  it("knows positional titles from real ones", () => {
    for (const t of ["Introduction", "Conclusion", "Front matter", "Part 3 — Pricing", "Chapter 12", "Module 2", "Appendix A", "Introduction (part 1/2)"]) expect(isGenericSectionTitle(t), t).toBe(true);
    for (const t of ["The Show Bonus", "Hyper-Care", "The Monopoly Board (part 2/2)", "Partnerships That Pay"]) expect(isGenericSectionTitle(t), t).toBe(false);
    expect(baseSectionTitle("The Monopoly Board (part 2/3)")).toBe("The Monopoly Board");
    expect(baseSectionTitle("The Show Bonus")).toBe("The Show Bonus");
  });

  it("sourceKey is stable for the same source and changes with title, length or opening", () => {
    const text = prose(3000);
    const k = sourceKey("Pre Sold", text);
    expect(k).toMatch(/^[0-9a-f]{8}$/);
    expect(sourceKey(" pre sold ", text)).toBe(k);
    expect(sourceKey("Other Book", text)).not.toBe(k);
    expect(sourceKey("Pre Sold", `${text}!`)).not.toBe(k);
    expect(sourceKey("Pre Sold", `X${text.slice(1)}`)).not.toBe(k);
  });
});
