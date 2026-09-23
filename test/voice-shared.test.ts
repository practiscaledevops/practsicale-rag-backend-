import { describe, it, expect } from "vitest";
import {
  MAX_UPLOAD_BYTES,
  MIME_CANDIDATES,
  appendText,
  fileNameForMime,
  formatElapsed,
  overUploadLimit,
  pickRecorderMimeType,
} from "@/lib/voice-shared";

describe("pickRecorderMimeType", () => {
  it("returns the first candidate the browser supports", () => {
    // Only mp4 is supported (Safari-like).
    expect(pickRecorderMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
  });

  it("prefers opus/webm when everything is supported", () => {
    expect(pickRecorderMimeType(() => true)).toBe(MIME_CANDIDATES[0]);
    expect(pickRecorderMimeType(() => true)).toBe("audio/webm;codecs=opus");
  });

  it("returns undefined when nothing is supported (browser default)", () => {
    expect(pickRecorderMimeType(() => false)).toBeUndefined();
  });
});

describe("overUploadLimit", () => {
  it("is false at or below the cap and true above it", () => {
    expect(overUploadLimit(0)).toBe(false);
    expect(overUploadLimit(MAX_UPLOAD_BYTES)).toBe(false);
    expect(overUploadLimit(MAX_UPLOAD_BYTES + 1)).toBe(true);
  });
});

describe("fileNameForMime", () => {
  it("maps the recorder mime (ignoring codecs) to a matching extension", () => {
    expect(fileNameForMime("audio/webm;codecs=opus")).toBe("voice.webm");
    expect(fileNameForMime("audio/ogg;codecs=opus")).toBe("voice.ogg");
    expect(fileNameForMime("audio/mp4")).toBe("voice.mp4");
    expect(fileNameForMime("audio/mpeg")).toBe("voice.mp3");
    expect(fileNameForMime("audio/wav")).toBe("voice.wav");
  });

  it("falls back to voice.webm for unknown / empty types", () => {
    expect(fileNameForMime("")).toBe("voice.webm");
    expect(fileNameForMime(null)).toBe("voice.webm");
    expect(fileNameForMime("application/octet-stream")).toBe("voice.webm");
  });
});

describe("formatElapsed", () => {
  it("formats mm:ss and pads seconds", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(7_000)).toBe("0:07");
    expect(formatElapsed(83_000)).toBe("1:23");
    expect(formatElapsed(-5)).toBe("0:00");
  });
});

describe("appendText", () => {
  it("returns the addition when there is no current text", () => {
    expect(appendText("", "hello world")).toBe("hello world");
  });

  it("joins onto existing text with a single separating space", () => {
    expect(appendText("First note.", "Second note.")).toBe("First note. Second note.");
  });

  it("does not add a space when the current text already ends in whitespace", () => {
    expect(appendText("First note.\n", "Second.")).toBe("First note.\nSecond.");
  });

  it("ignores a blank addition", () => {
    expect(appendText("keep me", "   ")).toBe("keep me");
  });
});
