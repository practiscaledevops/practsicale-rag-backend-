import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { demoSavedAnswerSources as sources } from "@/lib/demo/stream";
import { knowledgeScopeDef } from "@/lib/knowledge-scopes";
import { loadSavedAnswerSources, loadSavedCitation, planSavedAnswerFollowup, renderSavedAnswer } from "@/lib/saved-answer-followup";

const prior = [
  "Here's the breakdown:",
  "",
  `1. Send the first reminder 24 hours before the appointment. [${sources[0].id}]`,
  `2. If the buyer has not confirmed, send a second reminder 2 hours before the appointment. [${sources[1].id}]`,
  `3. Track show-up rate weekly using attended appointments divided by scheduled appointments. [${sources[2].id}]`,
].join("\n");

const history = (request: string, previous = prior) => [
  { role: "user", content: "What does the appointment reminder playbook recommend?" },
  { role: "assistant", content: previous },
  { role: "user", content: request },
];

describe("saved answer follow-ups", () => {
  it("puts the exact details and citations in a table and can explain a point in that table", () => {
    const plan = planSavedAnswerFollowup(history("Turn that into a table."))!;
    const result = renderSavedAnswer(plan, sources);
    expect(result).toContain(`| 2 | If the buyer has not confirmed, send a second reminder 2 hours before the appointment. [${sources[1].id}] |`);
    for (const source of sources) expect(result).toContain(`[${source.id}]`);
    const explanation = planSavedAnswerFollowup(history("Explain point two.", result!))!;
    expect(explanation.point).toBe(2);
    expect(explanation.citationIds).toEqual([sources[1].id]);
  });

  it("shortens framing and preserves all facts, qualifications and citations verbatim", () => {
    const plan = planSavedAnswerFollowup(history("Make it shorter."))!;
    expect(renderSavedAnswer(plan, sources)).toBe(prior.split("\n").slice(2).join("\n"));
  });

  it("explains point two with relevant additional text from the same source", () => {
    const plan = planSavedAnswerFollowup(history("Explain point two."))!;
    const result = renderSavedAnswer(plan, [sources[1]]);
    expect(result).toContain("If the buyer has not confirmed, send a second reminder 2 hours");
    expect(result).toContain("buyers who have already confirmed do not receive another reminder");
    expect(result).toContain(`[${sources[1].id}]`);
    expect(result).not.toContain(`[${sources[0].id}]`);
  });

  it.each([
    "Make it shorter for Team Mike.",
    "Explain point two for last week.",
    "Turn that into a table using Payroll.",
    "Compare with last week.",
  ])("leaves requests with a new scope on the normal path (%s)", (request) => {
    expect(planSavedAnswerFollowup(history(request))).toBeNull();
  });

  it("checks current organization, source, connector and collection filters in the document lookup", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => Response.json([sources[1]]));
    const db = createClient("https://test.example.test", "local-test-key", { global: { fetch } });
    const scope = { sourceTypes: ["document"], dataSourceIds: ["connector-id"], collectionIds: ["collection-id"] };
    const signal = new AbortController().signal;
    const found = await loadSavedAnswerSources(db, "company-a", scope, knowledgeScopeDef("auto"), [sources[1].id], signal);
    expect(found).toEqual([sources[1]]);
    const url = new URL(String(fetch.mock.calls.at(0)?.[0]));
    expect(url.searchParams.get("org_id")).toBe("eq.company-a");
    expect(url.searchParams.get("documents.org_id")).toBe("eq.company-a");
    expect(url.searchParams.get("source_type")).toBe("eq.document");
    expect(url.searchParams.get("data_source_id")).toBe("in.(connector-id)");
    expect(url.searchParams.get("collection_ids")).toBe("ov.{collection-id}");
    expect(url.searchParams.get("id")).toBe(`in.(${sources[1].id})`);
    expect(await loadSavedAnswerSources(db, "company-a", scope, knowledgeScopeDef("playbook"), [sources[1].id], signal)).toBeNull();
    expect(await loadSavedAnswerSources(db, "company-a", scope, knowledgeScopeDef("auto"), [sources[0].id, sources[1].id], signal)).toBeNull();
  });

  it("resolves unique short citations and refuses an ambiguous prefix", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) => Response.json([sources[1]]));
    const db = createClient("https://test.example.test", "local-test-key", { global: { fetch } });
    const scope = { sourceTypes: [], dataSourceIds: [], collectionIds: [] };
    const signal = new AbortController().signal;
    const prefix = sources[1].id.slice(0, 8);
    expect(await loadSavedAnswerSources(db, "company-a", scope, knowledgeScopeDef("auto"), [prefix], signal)).toEqual([sources[1]]);
    fetch.mockResolvedValueOnce(Response.json([sources[1], { ...sources[1], id: `${prefix}-0000-0000-0000-000000000000` }]));
    expect(await loadSavedAnswerSources(db, "company-a", scope, knowledgeScopeDef("auto"), [prefix], signal)).toBeNull();
  });

  it("resolves the original scorecard only in its current organization, source and collection scope", async () => {
    const card = {
      ...sources[0], source_type: "call_score",
      documents: { ...sources[0].documents, source_type: "call_score", overall_score: 0 },
    };
    const fetch = vi.fn(async (_input: RequestInfo | URL) => Response.json([card]));
    const db = createClient("https://test.example.test", "local-test-key", { global: { fetch } });
    const scope = { sourceTypes: ["call_score"], dataSourceIds: ["connector-id"], collectionIds: ["collection-id"] };
    const signal = new AbortController().signal;
    expect(await loadSavedCitation(db, "company-a", scope, card.id.slice(0, 8), signal)).toEqual(card);
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.searchParams.get("org_id")).toBe("eq.company-a");
    expect(url.searchParams.get("documents.org_id")).toBe("eq.company-a");
    expect(url.searchParams.get("source_type")).toBe("eq.call_score");
    expect(url.searchParams.get("documents.source_type")).toBe("eq.call_score");
    expect(url.searchParams.get("data_source_id")).toBe("in.(connector-id)");
    expect(url.searchParams.get("collection_ids")).toBe("ov.{collection-id}");

    expect(await loadSavedCitation(db, "company-a", { ...scope, sourceTypes: ["document"] }, card.id, signal)).toBeNull();
    expect(await loadSavedCitation(db, "company-a", { ...scope, sourceTypes: ["transcript"] }, card.id, signal)).toBeNull();
    expect(await loadSavedAnswerSources(db, "company-a", scope, knowledgeScopeDef("all"), [card.id], signal)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
