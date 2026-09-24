import { describe, it, expect } from "vitest";
import {
  resolveReviewFilterWithHistory,
  isReviewFollowUp,
  isConversationSummary,
  parseCallReviewFilter,
  detectConsultants,
  looksLikeReview,
  summaryCarriesCallFilter,
  CONVERSATION_SUMMARY_PREFIX,
  type ReviewHistoryTurn,
} from "@/lib/call-review";

// "Today" for the conversation (the orchestrator / jobs routes pass the business
// day). "yesterday" therefore resolves to 2026-09-24.
const TODAY = "2026-09-25";
const YESTERDAY = "2026-09-24";
const KNOWN = ["David Miller", "James Ephrim", "Kate Melody", "Sherman Mathews"];
const OPTS = { referenceDate: TODAY, knownConsultants: KNOWN };

const u = (content: string): ReviewHistoryTurn => ({ role: "user", content });
const a = (content: string): ReviewHistoryTurn => ({ role: "assistant", content });
const summary = (body: string): ReviewHistoryTurn => ({ role: "system", content: `${CONVERSATION_SUMMARY_PREFIX}\n${body}` });
const resolve = (query: string, history: ReviewHistoryTurn[], opts = OPTS) => resolveReviewFilterWithHistory(query, history, opts);

/** A listing turn + a plausible assistant answer, the common opener. */
const listedYesterday = [u("list yesterday consultants calls"), a("Here are the 12 calls from 2026-09-24: …")];

describe("the opener itself reads as a call listing", () => {
  it("'list yesterday consultants calls' is a review of yesterday (list … calls with words between)", () => {
    expect(parseCallReviewFilter("list yesterday consultants calls", OPTS)).toEqual({ isReview: true, date: YESTERDAY });
  });
  it("'show me James's NEMT calls' is a review", () => {
    expect(parseCallReviewFilter("show me James Ephrim's NEMT calls", OPTS)).toEqual({
      isReview: true,
      consultants: ["James Ephrim"],
      practiceType: "NEMT",
    });
  });
  it("the show-up rate is not a listing verb", () => {
    expect(looksLikeReview("what's the show up rate this month")).toBe(false);
  });
  it("a capitalised opener no longer swallows the name", () => {
    expect(detectConsultants("And David's?")).toEqual(["David"]);
    expect(detectConsultants("Review James Ephrim's calls")).toEqual(["James Ephrim"]);
    expect(detectConsultants("Last Week's calls")).toEqual([]);
  });
});

describe("date inherited", () => {
  it("'analyse all calls do audit' after 'list yesterday consultants calls' → yesterday", () => {
    expect(resolve("analyse all calls do audit", listedYesterday)).toEqual({ isReview: true, date: YESTERDAY });
  });
  it("a consultant-only review inherits the earlier date", () => {
    expect(resolve("audit james calls", listedYesterday)).toEqual({ isReview: true, date: YESTERDAY, consultants: ["james"] });
  });
  it("a range is inherited as a range", () => {
    expect(resolve("audit them", [u("review last week's calls"), a("…")])).toEqual({
      isReview: true,
      dateFrom: "2026-09-19",
      dateTo: TODAY,
    });
  });
  it("a date the current query names wins over the inherited one", () => {
    expect(resolve("review the calls from 22 September", listedYesterday)).toEqual({ isReview: true, date: "2026-09-22" });
  });
  it("a call-scoped turn without a review verb still anchors the date ('how did today's calls go?')", () => {
    expect(resolve("audit james calls", [u("how did today's calls go?"), a("…")])).toEqual({
      isReview: true,
      date: TODAY,
      consultants: ["james"],
    });
  });
  it("'all-time' drops the inherited date but keeps the consultant", () => {
    expect(resolve("review them all-time", [u("review James Ephrim's calls yesterday"), a("…")])).toEqual({
      isReview: true,
      consultants: ["James Ephrim"],
    });
  });
});

describe("consultant inherited", () => {
  it("a new date keeps the earlier consultant", () => {
    expect(resolve("review the calls from 22 September", [u("review James Ephrim's calls"), a("…")])).toEqual({
      isReview: true,
      date: "2026-09-22",
      consultants: ["James Ephrim"],
    });
  });
  it("a practice-type follow-up keeps consultant AND date", () => {
    expect(resolve("now the NEMT ones", [u("review James Ephrim's calls from yesterday"), a("…")])).toEqual({
      isReview: true,
      date: YESTERDAY,
      consultants: ["James Ephrim"],
      practiceType: "NEMT",
    });
  });
  it("practice type is inherited too", () => {
    expect(resolve("review yesterday's calls", [u("review the NEMT calls"), a("…")])).toEqual({
      isReview: true,
      date: YESTERDAY,
      practiceType: "NEMT",
    });
  });
});

describe("consultant replaced", () => {
  const prior = [u("review James Ephrim's calls from yesterday"), a("James had 4 calls …")];
  it("'and David's?' swaps the consultant and keeps the date", () => {
    expect(resolve("and David's?", prior)).toEqual({ isReview: true, date: YESTERDAY, consultants: ["David"] });
  });
  it("a lowercase first name resolves through the known roster", () => {
    expect(resolve("and david?", prior)).toEqual({ isReview: true, date: YESTERDAY, consultants: ["david"] });
  });
  it("a full review naming a consultant replaces (not adds to) the earlier one", () => {
    expect(resolve("audit Kate Melody's calls", prior)).toEqual({ isReview: true, date: YESTERDAY, consultants: ["Kate Melody"] });
  });
  it("'what about yesterday?' swaps the date and keeps the consultant", () => {
    expect(resolve("what about yesterday?", [u("review James Ephrim's calls from 22 September"), a("…")])).toEqual({
      isReview: true,
      date: YESTERDAY,
      consultants: ["James Ephrim"],
    });
  });
  it("follow-ups chain: list → and David's? → what about NEMT?", () => {
    const h = [...listedYesterday, u("and David's?"), a("David had 3 calls …")];
    expect(resolve("what about NEMT?", h)).toEqual({ isReview: true, date: YESTERDAY, consultants: ["David"], practiceType: "NEMT" });
  });
});

describe("widening drops the inherited consultants", () => {
  const prior = [u("review James Ephrim's calls from yesterday"), a("…")];
  it("'all consultants'", () => {
    expect(resolve("now audit all consultants", prior)).toEqual({ isReview: true, date: YESTERDAY });
  });
  it("'every consultant'", () => {
    expect(resolve("review every consultant's calls", prior)).toEqual({ isReview: true, date: YESTERDAY });
  });
  it("'the whole team'", () => {
    expect(resolve("what about the whole team?", prior)).toEqual({ isReview: true, date: YESTERDAY });
  });
  it("'everyone'", () => {
    expect(resolve("audit everyone", prior)).toEqual({ isReview: true, date: YESTERDAY });
  });
  it("'team-wide'", () => {
    expect(resolve("do a team-wide review of them", prior)).toEqual({ isReview: true, date: YESTERDAY });
  });
  it("'all practice types' drops the inherited practice", () => {
    expect(resolve("review them across all practice types", [u("review the NEMT calls from yesterday"), a("…")])).toEqual({
      isReview: true,
      date: YESTERDAY,
    });
  });
  it("widening everything that was inherited leaves no usable filter", () => {
    expect(resolve("audit all consultants", [u("review James Ephrim's calls"), a("…")]).isReview).toBe(false);
  });
});

describe("pronoun / action follow-ups", () => {
  for (const q of [
    "audit them",
    "do a deep audit of these",
    "analyse all calls do audit",
    "score each of them",
    "break them down",
    "compare those calls",
    "summarize the calls",
    "grade all of them against the playbook",
    "deep dive into these",
    "evaluate them and coach the weakest",
  ]) {
    it(`'${q}' → yesterday's review`, () => {
      expect(resolve(q, listedYesterday)).toEqual({ isReview: true, date: YESTERDAY });
    });
  }
  it("a short bare action right after a review ('do a deep audit')", () => {
    expect(resolve("do a deep audit", listedYesterday)).toEqual({ isReview: true, date: YESTERDAY });
  });
  it("an action follow-up reaches past an unrelated turn to the last review", () => {
    const h = [...listedYesterday, u("what is our pricing?"), a("…")];
    expect(resolve("audit them", h)).toEqual({ isReview: true, date: YESTERDAY });
  });
  it("isReviewFollowUp needs both an analysis verb and a reference to earlier results", () => {
    expect(isReviewFollowUp("audit them")).toBe(true);
    expect(isReviewFollowUp("analyse all calls do audit")).toBe(true);
    expect(isReviewFollowUp("summarise all")).toBe(true);
    expect(isReviewFollowUp("compare all our pricing plans")).toBe(false);
    expect(isReviewFollowUp("them")).toBe(false);
    expect(isReviewFollowUp("audit")).toBe(false);
    expect(isReviewFollowUp("write me a LinkedIn post")).toBe(false);
    expect(isReviewFollowUp("")).toBe(false);
  });
});

describe("unrelated follow-ups are NOT reviews", () => {
  for (const q of [
    "write me a LinkedIn post",
    "write a LinkedIn post about David's week",
    "thanks, great review!",
    "what is our pricing?",
    "how do I handle the price objection?",
    "hi",
  ]) {
    it(`'${q}'`, () => {
      expect(resolve(q, listedYesterday).isReview).toBe(false);
    });
  }
  it("a short follow-up only continues when the PREVIOUS user turn was a review", () => {
    const h = [...listedYesterday, u("write me a LinkedIn post"), a("Here's a post …")];
    expect(resolve("and David's?", h).isReview).toBe(false);
  });
  it("no history → the standalone parse", () => {
    expect(resolve("audit them", [])).toEqual({ isReview: false });
    expect(resolve("review the NEMT calls", [])).toEqual({ isReview: true, practiceType: "NEMT" });
  });
  it("a content-creation turn does not anchor a filter", () => {
    const h = [u("write a LinkedIn post about our consultant David Miller"), a("…")];
    expect(resolve("audit them", h).isReview).toBe(false);
  });
});

describe("history shape", () => {
  it("the chat API's trailing copy of the current message is ignored", () => {
    expect(resolve("audit them", [...listedYesterday, u("audit them")])).toEqual({ isReview: true, date: YESTERDAY });
  });
  it("assistant turns never supply a filter", () => {
    const h = [u("hello"), a("Reviewing James Ephrim's NEMT calls from 2026-09-20 …")];
    expect(resolve("audit them", h).isReview).toBe(false);
  });
  it("non-summary system turns are ignored", () => {
    const h: ReviewHistoryTurn[] = [{ role: "system", content: "Review James Ephrim's calls from yesterday" }];
    expect(resolve("audit them", h).isReview).toBe(false);
  });
  it("malformed turns are skipped, not thrown on", () => {
    const h = [null, { role: "user" }, ...listedYesterday] as unknown as ReviewHistoryTurn[];
    expect(resolve("audit them", h)).toEqual({ isReview: true, date: YESTERDAY });
  });
});

describe("compaction summary fallback", () => {
  it("recognises a summary turn", () => {
    expect(isConversationSummary(summary("- x"))).toBe(true);
    expect(isConversationSummary({ role: "user", content: `${CONVERSATION_SUMMARY_PREFIX} x` })).toBe(false);
    expect(isConversationSummary({ role: "system", content: "You are…" })).toBe(false);
  });
  it("the explicit 'Active call-review filter' line is used when no user turn yields a filter", () => {
    const h = [
      summary(
        "## Goals\n- Audit the team's calls\n## Key facts\n- 12 calls on 2026-09-20; Kate Melody scored lowest (54/100)\n" +
          "Active call-review filter: date=2026-09-20 | consultants=Kate Melody | practice=NEMT"
      ),
      u("thanks"),
      a("You're welcome."),
    ];
    expect(resolve("audit them", h)).toEqual({ isReview: true, date: "2026-09-20", consultants: ["Kate Melody"], practiceType: "NEMT" });
  });
  it("a range in the explicit line", () => {
    const h = [summary("- …\nActive call-review filter: range=2026-09-14 to 2026-09-20 | consultants=none")];
    expect(resolve("do a deep audit of these", h)).toEqual({ isReview: true, dateFrom: "2026-09-14", dateTo: "2026-09-20" });
  });
  it("without the explicit line, the last call-review line of the summary is parsed", () => {
    const h = [summary("- User asked about pricing tiers.\n- User reviewed the NEMT calls from 2026-09-18; 5 calls, avg 71.")];
    expect(resolve("audit them", h)).toEqual({ isReview: true, date: "2026-09-18", practiceType: "NEMT" });
  });
  it("a short follow-up right after compaction continues the summary's filter", () => {
    const h = [summary("Active call-review filter: date=2026-09-20 | consultants=James Ephrim")];
    expect(resolve("and David's?", h)).toEqual({ isReview: true, date: "2026-09-20", consultants: ["David"] });
  });
  it("a user turn's filter wins over the summary", () => {
    const h = [summary("Active call-review filter: date=2026-09-20"), ...listedYesterday];
    expect(resolve("audit them", h)).toEqual({ isReview: true, date: YESTERDAY });
  });
  it("an explicit 'none' filter line means nothing to inherit", () => {
    const h = [summary("- Discussed pricing for the NEMT calls on 2026-09-18.\nActive call-review filter: none")];
    expect(resolve("audit them", h).isReview).toBe(false);
  });
  it("a summary that never touched calls yields nothing", () => {
    const h = [summary("- User drafted a LinkedIn post about hiring.\n- Decided to post on Tuesday.")];
    expect(resolve("audit them", h).isReview).toBe(false);
  });
  it("without the explicit line, an analysis / breakdown / review of something that is not calls is not a filter", () => {
    expect(resolve("what about last month?", [summary("- User asked for an analysis of the onboarding SOP revision dated 2026-09-01")]).isReview).toBe(false);
    expect(resolve("summarise that", [summary("- User asked for a breakdown of the Home Care pricing plan")]).isReview).toBe(false);
    expect(resolve("and last week?", [summary("- User asked for a review of the LinkedIn post drafted this month")]).isReview).toBe(false);
  });
  it("summaryCarriesCallFilter: the marker alone is not review intent", () => {
    const opts = { referenceDate: TODAY };
    expect(looksLikeReview(`${CONVERSATION_SUMMARY_PREFIX}\n- User drafted a LinkedIn post about hiring.`)).toBe(true); // why the gate can't keyword-test it
    expect(summaryCarriesCallFilter(`${CONVERSATION_SUMMARY_PREFIX}\n- User drafted a LinkedIn post about hiring.`, opts)).toBe(false);
    expect(summaryCarriesCallFilter(`${CONVERSATION_SUMMARY_PREFIX}\n- …\nActive call-review filter: date=2026-09-20`, opts)).toBe(true);
    expect(summaryCarriesCallFilter(`${CONVERSATION_SUMMARY_PREFIX}\n- User reviewed the NEMT calls from 2026-09-18.`, opts)).toBe(true);
  });
});

describe("a short question naming a practice / date / consultant is not a review by itself", () => {
  for (const q of ["what's our NEMT pricing?", "how do we onboard Home Care clients?", "what is our offer for NEMT?"]) {
    it(`'${q}' after a call listing`, () => {
      expect(resolve(q, listedYesterday).isReview).toBe(false);
    });
  }
  it("…and it does not narrow the active filter for a later 'audit them'", () => {
    expect(resolve("audit them", [...listedYesterday, u("what's our NEMT pricing?"), a("…")])).toEqual({ isReview: true, date: YESTERDAY });
  });
  for (const [q, want] of [
    ["what about 22 September?", { isReview: true, date: "2026-09-22" }],
    ["and Sept 20th?", { isReview: true, date: "2026-09-20" }],
    ["and 9/20?", { isReview: true, date: "2026-09-20" }],
    ["and last week?", { isReview: true, dateFrom: "2026-09-19", dateTo: TODAY }],
    ["NEMT calls?", { isReview: true, date: YESTERDAY, practiceType: "NEMT" }],
  ] as const) {
    it(`a bare filter swap still continues: '${q}'`, () => {
      expect(resolve(q, listedYesterday)).toEqual(want);
    });
  }
});

describe("an old review filter does not hijack later generic actions", () => {
  const rev = [u("review James's calls from yesterday"), a("James had 4 calls …")];
  const afterHooks = [...rev, u("Now write me 3 LinkedIn hooks about objection handling"), a("1. … 2. … 3. …")];
  for (const q of [
    "Compare these",
    "summarize them into an email",
    "thanks, can you summarize all of that?",
    "Score these hooks",
    "Can you break these down into bullet points",
  ]) {
    it(`'${q}' after a content-creation turn`, () => {
      expect(resolve(q, afterHooks).isReview).toBe(false);
    });
  }
  const afterQuestions = [...rev, u("What is our pricing for Home Health?"), a("…"), u("Give me 5 tips for closing faster"), a("…")];
  for (const q of ["Compare these", "summarize them into an email"]) {
    it(`'${q}' after unrelated questions`, () => {
      expect(resolve(q, afterQuestions).isReview).toBe(false);
    });
  }
  it("a generic action right after the review still continues it", () => {
    expect(resolve("compare these", rev)).toEqual({ isReview: true, date: YESTERDAY, consultants: ["James"] });
  });
  it("a call-specific action reaches back past unrelated questions", () => {
    expect(resolve("audit them", afterQuestions)).toEqual({ isReview: true, date: YESTERDAY, consultants: ["James"] });
    expect(resolve("compare those calls", afterQuestions)).toEqual({ isReview: true, date: YESTERDAY, consultants: ["James"] });
  });
  it("isReviewFollowUp ignores content-creation asks and thanks", () => {
    expect(isReviewFollowUp("summarize them into an email")).toBe(false);
    expect(isReviewFollowUp("thanks, can you summarize all of that?")).toBe(false);
  });
});

describe("listing verbs must point at calls", () => {
  for (const q of ["give me tips for NEMT calls", "show me how James handles calls", "give me advice on James's calls"]) {
    it(`'${q}' is not a review`, () => {
      expect(looksLikeReview(q)).toBe(false);
      expect(parseCallReviewFilter(q, OPTS).isReview).toBe(false);
    });
  }
  for (const q of ["give me all NEMT calls", "fetch James's calls", "show me yesterday's Home Care calls", "give me the Phlebotomy transcripts", "pull up today's calls"]) {
    it(`'${q}' is still a listing`, () => {
      expect(looksLikeReview(q)).toBe(true);
    });
  }
});

describe("history turns resolve relative dates against the day they were sent", () => {
  const at = (content: string, createdAt: string): ReviewHistoryTurn => ({ role: "user", content, createdAt });
  it("'audit them' the next day keeps the day that was listed", () => {
    const h = [at("list yesterday consultants calls", "2026-09-25T10:00:00Z"), a("Here are the calls from 2026-09-24 …")];
    expect(resolve("audit them", h, { referenceDate: "2026-09-26", knownConsultants: KNOWN })).toEqual({ isReview: true, date: "2026-09-24" });
  });
  it("a reopened chat: 'deep audit of them' a day later", () => {
    const h = [at("list yesterday's calls", "2026-09-24T10:00:00Z"), a("…2026-09-23…")];
    expect(resolve("deep audit of them", h, { referenceDate: "2026-09-25", knownConsultants: KNOWN })).toEqual({ isReview: true, date: "2026-09-23" });
  });
  it("uses the business day (UTC+5), not the UTC day", () => {
    // 20:00Z on the 24th is already the 25th in the office.
    const h = [at("list yesterday's calls", "2026-09-24T20:00:00Z"), a("…")];
    expect(resolve("audit them", h, { referenceDate: "2026-09-26", knownConsultants: KNOWN })).toEqual({ isReview: true, date: "2026-09-24" });
  });
  it("a missing, malformed or future createdAt falls back to today", () => {
    for (const createdAt of [undefined, "", "1", "not a date", "2026-12-01T00:00:00Z"]) {
      const h = [{ role: "user", content: "list yesterday's calls", ...(createdAt === undefined ? {} : { createdAt }) }, a("…")];
      expect(resolve("audit them", h)).toEqual({ isReview: true, date: YESTERDAY });
    }
  });
  it("the current query still resolves against today", () => {
    const h = [at("review James Ephrim's calls", "2026-09-20T10:00:00Z"), a("…")];
    expect(resolve("and yesterday's?", h)).toEqual({ isReview: true, date: YESTERDAY, consultants: ["James Ephrim"] });
  });
});
