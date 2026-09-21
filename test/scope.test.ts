import { describe, it, expect } from "vitest";
import { narrowScope } from "@/lib/auth/scope";
import type { ApiKeyRecord } from "@/lib/auth/context";

// A minimal key record for scope tests.
function key(over: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    source_types: [],
    data_source_ids: [],
    collection_ids: [],
    ...over,
  } as ApiKeyRecord;
}

describe("narrowScope (role-based knowledge partitioning)", () => {
  it("no request → the key's scope unchanged", () => {
    const s = narrowScope(key({ source_types: [] }), undefined);
    expect(s.sourceTypes).toEqual([]);
  });

  it("unrestricted key + requested set → narrowed to the request", () => {
    const s = narrowScope(key({ source_types: [] }), { sourceTypes: ["document"] });
    expect(s.sourceTypes).toEqual(["document"]); // e.g. general team: no call_score
  });

  it("can only narrow, never widen past the key", () => {
    // Key is limited to document; caller asks for call_score too → still only document.
    const s = narrowScope(key({ source_types: ["document"] }), {
      sourceTypes: ["document", "call_score"],
    });
    expect(s.sourceTypes).toEqual(["document"]);
  });

  it("empty intersection maps to match-nothing, NOT [] (which means all)", () => {
    // Key only allows document; caller asks for call_score only → nothing.
    const s = narrowScope(key({ source_types: ["document"] }), { sourceTypes: ["call_score"] });
    expect(s.sourceTypes).not.toEqual([]); // must not become "no restriction"
    expect(s.sourceTypes).toEqual(["__none__"]);
  });

  it("empty requested array is treated as 'not specified' (no narrowing)", () => {
    const s = narrowScope(key({ source_types: ["document", "call_score"] }), { sourceTypes: [] });
    expect(s.sourceTypes).toEqual(["document", "call_score"]);
  });

  it("narrows collection ids the same way", () => {
    const s = narrowScope(key({ collection_ids: [] }), { collectionIds: ["c1"] });
    expect(s.collectionIds).toEqual(["c1"]);
  });

  it("an empty collection intersection uses the nil uuid (the SQL parameter is uuid[])", () => {
    const s = narrowScope(key({ collection_ids: ["c1"] }), { collectionIds: ["c2"] });
    expect(s.collectionIds).toEqual(["00000000-0000-0000-0000-000000000000"]);
  });
});
