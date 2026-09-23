import { describe, it, expect } from "vitest";
import { assembleFullCalls, type RetrievedChunk } from "@/lib/retrieval";

// Pure logic only — no DB. assembleFullCalls is the grouping/budget/rebuild core
// of expandTranscripts; expandTranscripts just fetches each target call's chunks
// (created_at ASC = reading order) and hands them here.

function chunk(over: Partial<RetrievedChunk> & { id: string; document_id: string }): RetrievedChunk {
  return {
    content: over.id,
    metadata: {},
    parent_id: null,
    source_type: "transcript",
    ...over,
  };
}

/** A full call in reading order: summary first, then body chunks. `tk` per-chunk tokens. */
function call(doc: string, bodyCount: number, tk = 500): RetrievedChunk[] {
  const out = [chunk({ id: `${doc}-sum`, document_id: doc, metadata: { is_summary: true, tokens: tk } })];
  for (let i = 1; i <= bodyCount; i++) {
    out.push(chunk({ id: `${doc}-b${i}`, document_id: doc, metadata: { is_transcript_body: true, tokens: tk } }));
  }
  return out;
}

const ids = (chunks: RetrievedChunk[]) => chunks.map((c) => c.id);

describe("assembleFullCalls", () => {
  it("replaces a call's summary-only pick with its full transcript, in reading order", () => {
    const A = call("A", 3); // A-sum, A-b1, A-b2, A-b3
    // Retrieval surfaced only A's summary chunk.
    const input = [A[0]];
    const out = assembleFullCalls(input, new Map([["A", A]]), 3, 100_000);
    expect(ids(out)).toEqual(["A-sum", "A-b1", "A-b2", "A-b3"]);
  });

  it("preserves overall ordering and leaves non-transcript chunks untouched", () => {
    const n1 = chunk({ id: "n1", document_id: "dN1", source_type: "document" });
    const n2 = chunk({ id: "n2", document_id: "dN2", source_type: "markdown" });
    const A = call("A", 2); // best chunk = summary
    const B = call("B", 2);
    // Rank order: n1, A(summary), n2, B(a middle body chunk).
    const input = [n1, A[0], n2, B[2]];
    const out = assembleFullCalls(input, new Map([["A", A], ["B", B]]), 3, 100_000);
    // Each call takes the rank position of its best chunk; the calls expand in place.
    expect(ids(out)).toEqual(["n1", "A-sum", "A-b1", "A-b2", "n2", "B-sum", "B-b1", "B-b2"]);
    // The non-transcript chunks pass through as the SAME objects, not copies.
    expect(out[0]).toBe(n1);
    expect(out.find((c) => c.id === "n2")).toBe(n2);
  });

  it("dedupes a call's other retrieved chunks so the full set appears once", () => {
    const A = call("A", 3);
    // Retrieval surfaced two of A's chunks (summary + a body chunk).
    const input = [A[0], A[2]];
    const out = assembleFullCalls(input, new Map([["A", A]]), 3, 100_000);
    expect(ids(out)).toEqual(["A-sum", "A-b1", "A-b2", "A-b3"]);
  });

  it("caps each call at its fair token share but always keeps summary + 1 body", () => {
    // One target → share = maxTokens. tokens: 300 each. Budget 1000.
    const A = [
      chunk({ id: "A-sum", document_id: "A", metadata: { is_summary: true, tokens: 300 } }),
      chunk({ id: "A-b1", document_id: "A", metadata: { tokens: 300 } }),
      chunk({ id: "A-b2", document_id: "A", metadata: { tokens: 300 } }),
      chunk({ id: "A-b3", document_id: "A", metadata: { tokens: 300 } }),
    ];
    const out = assembleFullCalls([A[0]], new Map([["A", A]]), 3, 1000);
    // 300 + 300 + 300 = 900 ≤ 1000; adding b3 (1200) would exceed → stop at b2.
    expect(ids(out)).toEqual(["A-sum", "A-b1", "A-b2"]);
  });

  it("keeps summary + 1 even when the summary alone blows the share", () => {
    const A = [
      chunk({ id: "A-sum", document_id: "A", metadata: { is_summary: true, tokens: 5000 } }),
      chunk({ id: "A-b1", document_id: "A", metadata: { tokens: 5000 } }),
      chunk({ id: "A-b2", document_id: "A", metadata: { tokens: 5000 } }),
    ];
    const out = assembleFullCalls([A[0]], new Map([["A", A]]), 3, 100);
    expect(ids(out)).toEqual(["A-sum", "A-b1"]);
  });

  it("falls back to content length when a chunk has no token count", () => {
    const A = [
      chunk({ id: "A-sum", document_id: "A", content: "x".repeat(2000), metadata: { is_summary: true } }), // ~500 tok
      chunk({ id: "A-b1", document_id: "A", content: "x".repeat(2000), metadata: {} }), // ~500 tok
      chunk({ id: "A-b2", document_id: "A", content: "x".repeat(2000), metadata: {} }), // ~500 tok
    ];
    // Budget 1100: 500 + 500 = 1000 ≤ 1100; adding b2 (1500) exceeds → stop.
    const out = assembleFullCalls([A[0]], new Map([["A", A]]), 3, 1100);
    expect(ids(out)).toEqual(["A-sum", "A-b1"]);
  });

  it("expands at most maxCalls calls; further calls pass through untouched", () => {
    const A = call("A", 2);
    const B = call("B", 2);
    const C = call("C", 2);
    // C is only represented by its summary in the ranked input.
    const input = [A[0], B[0], C[0]];
    const out = assembleFullCalls(input, new Map([["A", A], ["B", B]]), 2, 100_000);
    // A and B expand; C stays a single chunk (untouched), still in place.
    expect(ids(out)).toEqual(["A-sum", "A-b1", "A-b2", "B-sum", "B-b1", "B-b2", "C-sum"]);
    expect(out[out.length - 1]).toBe(C[0]);
  });

  it("returns the input unchanged when there are no transcript chunks", () => {
    const input = [
      chunk({ id: "n1", document_id: "d1", source_type: "document" }),
      chunk({ id: "n2", document_id: "d2", source_type: "markdown" }),
    ];
    const out = assembleFullCalls(input, new Map(), 3, 30_000);
    expect(out).toBe(input); // same reference — nothing to expand
  });
});
