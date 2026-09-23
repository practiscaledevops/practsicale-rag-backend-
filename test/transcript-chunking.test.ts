import { describe, it, expect } from "vitest";
import { parseTranscriptTurns, chunkDocument, type Chunk } from "@/lib/chunking";

// Pure logic only — no model call, no network.

const approxTokens = (s: string) => Math.ceil(s.length / 4);
const CAP = 1400;

/** A call's structured metadata as the connector stamps it on a transcript doc. */
const META = {
  consultant_name: "Sherman Mathews",
  prospect_name: "Cliff A",
  practice_type: "NEMT",
  category: "NEMT",
  call_date: "2026-09-22",
  call_outcome: "follow_up",
  overall_score: 82,
  performance_band: "Strong",
  call_duration_minutes: 56,
  recording_links: ["https://fathom.video/calls/abc123"],
};

/** One ~`chars`-long turn body so we can control chunk sizing precisely. */
function body(chars: number, word = "discovery"): string {
  const one = `${word} `;
  return one.repeat(Math.ceil(chars / one.length)).slice(0, chars).trim();
}

/** A transcript of `n` turns, each with a ~`chars`-char body, starting at 0:00. */
function transcript(n: number, chars: number): string {
  const turns: string[] = [];
  for (let i = 0; i < n; i++) {
    const mm = String(Math.floor(i / 60)).padStart(1, "0");
    const ss = String(i % 60).padStart(2, "0");
    const speaker = i % 2 === 0 ? "Sherman Mathews" : "Cliff A";
    turns.push(`${mm}:${ss} - ${speaker}\n  ${body(chars)}`);
  }
  return turns.join("\n\n");
}

const bodyChunks = (chunks: Chunk[]) => chunks.filter((c) => c.metadata.is_transcript_body);

describe("parseTranscriptTurns", () => {
  it("parses M:SS, MM:SS and H:MM:SS timestamps", () => {
    const text = [
      "0:17 - Sherman Mathews",
      "  Good afternoon.",
      "",
      "12:04 - Cliff A",
      "  Hello there.",
      "",
      "1:02:40 - Sherman Mathews",
      "  Wrapping up now.",
    ].join("\n");
    const turns = parseTranscriptTurns(text);
    expect(turns.map((t) => t.start)).toEqual(["0:17", "12:04", "1:02:40"]);
    expect(turns.map((t) => t.startSeconds)).toEqual([17, 724, 3760]);
  });

  it("keeps multi-line bodies whole and skips preamble before the first timestamp", () => {
    const text = [
      "Call transcript — Sherman Mathews → Cliff A",
      "Practice type: NEMT",
      "",
      "0:17 - Sherman Mathews",
      "  Line one.",
      "  Line two.",
      "",
      "  Line three after a blank.",
      "",
      "0:40 - Cliff A",
      "  Reply.",
    ].join("\n");
    const turns = parseTranscriptTurns(text);
    expect(turns).toHaveLength(2); // the header block is preamble, not a turn
    expect(turns[0].start).toBe("0:17");
    expect(turns[0].body).toContain("Line one.");
    expect(turns[0].body).toContain("Line two.");
    expect(turns[0].body).toContain("Line three after a blank.");
    expect(turns[0].text.startsWith("0:17 - Sherman Mathews")).toBe(true);
  });

  it("captures the speaker with or without an email", () => {
    const text = [
      "0:01 - Sherman Mathews (email)",
      "  Hi.",
      "",
      "0:05 - Cliff A",
      "  Hey.",
      "",
      "0:09 - Bob bob@example.com",
      "  Yes.",
    ].join("\n");
    const turns = parseTranscriptTurns(text);
    expect(turns.map((t) => t.speaker)).toEqual([
      "Sherman Mathews (email)",
      "Cliff A",
      "Bob bob@example.com",
    ]);
  });

  it("returns nothing for text with no timestamped turns", () => {
    expect(parseTranscriptTurns("just some prose\nwith no timestamps")).toEqual([]);
    expect(parseTranscriptTurns("")).toEqual([]);
  });
});

describe('chunkDocument(text, "transcript", meta)', () => {
  const chunks = chunkDocument(transcript(12, 1150), "transcript", META);
  const bodies = bodyChunks(chunks);

  it("emits a summary chunk first, carrying the header fields built from metadata", () => {
    const first = chunks[0];
    expect(first.metadata.is_summary).toBe(true);
    expect(first.metadata.source_type).toBe("transcript");
    const s = first.content;
    expect(s).toContain("Sherman Mathews → Cliff A");
    expect(s).toContain("Practice type: NEMT");
    expect(s).toContain("Call date: 2026-09-22");
    expect(s).toContain("Outcome: follow_up");
    expect(s).toContain("Score: 82/100 (Strong)");
    expect(s).toContain("Duration: 56 min");
    expect(s).toContain("Recording: https://fathom.video/calls/abc123");
  });

  it("prefixes every body chunk with a time-anchored locator (consultant, prospect, practice, date, span)", () => {
    expect(bodies.length).toBeGreaterThan(1);
    for (const c of bodies) {
      const locator = c.content.split("\n")[0];
      expect(locator.startsWith("[")).toBe(true);
      expect(locator.endsWith("]")).toBe(true);
      expect(locator).toContain("Sherman Mathews → Cliff A");
      expect(locator).toContain("NEMT");
      expect(locator).toContain("2026-09-22");
      expect(locator).toContain(String(c.metadata.turn_start));
    }
  });

  it("never splits a turn across a chunk boundary", () => {
    const all = parseTranscriptTurns(transcript(12, 1150)).map((t) => t.text);
    for (const c of bodies) {
      // Re-parse the chunk (the locator line is preamble) — every turn must be
      // one of the originals, verbatim (no half-turn at either edge).
      for (const t of parseTranscriptTurns(c.content)) {
        expect(all).toContain(t.text);
      }
    }
  });

  it("overlaps adjacent chunks by repeating a boundary turn", () => {
    for (let i = 1; i < bodies.length; i++) {
      const prev = parseTranscriptTurns(bodies[i - 1].content);
      const cur = parseTranscriptTurns(bodies[i].content);
      expect(cur[0].text).toBe(prev[prev.length - 1].text);
    }
  });

  it("respects the ~1,400-token cap for multi-turn chunks", () => {
    for (const c of bodies) {
      const turnCount = parseTranscriptTurns(c.content).length;
      if (turnCount > 1) expect(c.metadata.tokens as number).toBeLessThanOrEqual(CAP + 100);
    }
  });

  it("keeps a short transcript to one body chunk after the summary", () => {
    const small = chunkDocument(transcript(2, 200), "transcript", META);
    expect(small[0].metadata.is_summary).toBe(true);
    expect(bodyChunks(small)).toHaveLength(1);
    expect(approxTokens(bodyChunks(small)[0].content)).toBeLessThanOrEqual(CAP);
  });
});
