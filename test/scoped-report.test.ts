import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  readPayroll: vi.fn(),
}));

vi.mock("@/lib/auth/context", () => ({
  resolveContext: async () => ({
    orgId: "test-org", key: { id: "test-key", capabilities: ["chat"], source_types: [], data_source_ids: [], collection_ids: [] },
  }),
}));
vi.mock("@/lib/ratelimit", () => ({
  checkRateLimit: async () => ({ ok: true }),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/connectors/payroll-report", () => ({ payrollAccess: () => true }));
vi.mock("@/lib/connectors/source-access", () => ({ requireSourcePermission: mocks.permission }));
vi.mock("@/lib/connectors/payroll-live", () => ({ readLivePayroll: mocks.readPayroll }));

import { POST } from "@/app/api/v1/chat/route";
import { recallRequestedReportScope, resolveReportFollowup, supplementRecalledReportScope } from "@/lib/connectors/report-followup";

const timeZone = "Asia/Karachi";
const user = (content: string, createdAt = "2026-11-18T12:00:00Z") => ({ role: "user", content, createdAt });
const opening = user("Show Payroll closings this week.");
const myTeam = user("Just my team.");
const comparison = user("Compare with last week.");
const run = (messages: { role: string; content: string; createdAt?: string }[], reportTeam?: string, knowledgeScope?: string,
  earlierContext?: { userTurns: { content: string; createdAt?: string }[] }) => POST(new Request("http://localhost/api/v1/chat", {
  method: "POST",
  headers: { "content-type": "application/json", "x-chatbot-user-token": "test-session" },
  body: JSON.stringify({ messages, reportTeam, knowledgeScope, timeZone, earlierContext }),
}));

beforeEach(() => {
  mocks.permission.mockReset().mockResolvedValue("verified@example.test");
  mocks.readPayroll.mockReset().mockImplementation((_report, _email, from) => {
    const closings = from === "2026-11-16" ? 6 : 14;
    const team = { closings, usd_minor: closings * 65000, showed: 7, happened: 14, show_rate: 0.5 };
    return {
      fetched_at: "2026-11-18T12:00:00Z",
      data: { summary: { ...team, closings: 100, absent_shows: null }, teams: [{ label: "Team Fahad", ...team }] },
    };
  });
});

it("keeps the Payroll source, team and original relative dates outside a short prompt window", async () => {
  const older = [user("Show Payroll closings this week.", "2026-10-29T12:00:00Z"),
    user("Just Team Fahad"), ...Array.from({ length: 50 }, () => user("Thanks"))];
  const response = await run([user("Compare against 2026-10-19")], "Fahad", undefined, { userTurns: older });
  const text = await response.text();
  expect(text).toContain('"source":"Sales Payroll","team":"Team Fahad","from":"2026-10-26","through":"2026-10-29"');
  expect(text).toContain('"comparison":{"from":"2026-10-19","through":"2026-10-19"}');
  expect(mocks.permission).toHaveBeenCalledWith("test-session", "reporting.view", expect.any(AbortSignal));
});

it("treats an acknowledgement as chat instead of fetching the last report again", async () => {
  expect(resolveReportFollowup([opening, user("Thank you.")], timeZone).scope).toBeNull();
});

it("recalls the relevant user choice and avoids repeating scope already in the answer", () => {
  const prior = [
    user("For the appointment reminder review, use Team Fahad, 26–29 Oct 2026, and Sales Payroll."),
    { role: "assistant", content: "Use Team Guess, 25–26 Oct 2026, and GoHighLevel." },
    user("For the onboarding review, use Team Mike, 1–4 Nov 2026, and GoHighLevel."),
  ];
  const scope = recallRequestedReportScope("What did we decide earlier about the appointment reminder?", prior, timeZone);
  expect(scope).toEqual({ source: "payroll", team: "Team Fahad", range: { from: "2026-10-26", through: "2026-10-29" } });
  expect(recallRequestedReportScope("Remind me about the appointment reminder we discussed", prior, timeZone)).toEqual(scope);
  expect(supplementRecalledReportScope(scope!, "Team: Fahad, 26th to 29th October 2026, Sales Payroll.")).toBe("");
  expect(supplementRecalledReportScope(scope!, 'Team "Fahad" for 26–29 Oct 2026.')).toBe("\n\nEarlier scope you chose: **Sales Payroll**.");
});

it("recalls a scope assembled across earlier report turns using the original date", () => {
  const prior = [user("Show Payroll closings this week.", "2026-10-29T12:00:00Z"), user("Just Team Fahad")];
  expect(recallRequestedReportScope("What was our scope?", prior, timeZone)).toEqual({
    source: "payroll", team: "Team Fahad", range: { from: "2026-10-26", through: "2026-10-29" },
  });
});

it("does not restate old scope after a correction or for an unrelated question", () => {
  const earlier = user("For the appointment reminder review, use Team Fahad, 26–29 Oct 2026, and Sales Payroll.");
  expect(recallRequestedReportScope("What did we decide earlier about the appointment reminder?",
    [earlier, user("Use GHL instead.")], timeZone)).toBeNull();
  expect(recallRequestedReportScope("What did we decide earlier about pricing?", [earlier], timeZone)).toBeNull();
  expect(recallRequestedReportScope("What did we decide earlier about the appointment reminder, using GHL?", [earlier], timeZone)).toBeNull();
});

it("keeps the source, team, and original window when comparing with the prior calendar week", async () => {
  const response = await run([opening, myTeam, comparison], "Fahad");
  const text = await response.text();
  expect(text).toContain('"source":"Sales Payroll","team":"Team Fahad","from":"2026-11-16","through":"2026-11-18"');
  expect(text).toContain('"comparison":{"from":"2026-11-09","through":"2026-11-15"}');
  expect(text).toContain("| Closings | 6 | 14 |");
  expect(text).not.toContain("| Closings | 100");
  expect(mocks.permission).toHaveBeenCalledWith("test-session", "reporting.view", expect.any(AbortSignal));
  expect(mocks.readPayroll.mock.calls.map((args) => args.slice(0, 4))).toEqual([
    ["performance", "verified@example.test", "2026-11-16", "2026-11-18"],
    ["performance", "verified@example.test", "2026-11-09", "2026-11-15"],
  ]);
});

it("asks for a team when the signed-in profile has no team", async () => {
  expect(await (await run([opening, myTeam])).text()).toContain("primary team");
  expect(mocks.readPayroll).not.toHaveBeenCalled();
});

it("requires live authorization before reading either period", async () => {
  mocks.permission.mockRejectedValueOnce(new Error("forbidden"));
  expect(await (await run([opening, myTeam, comparison], "Fahad")).text()).not.toContain("report_scope");
  expect(mocks.readPayroll).not.toHaveBeenCalled();
});

it("does not switch to Payroll when the source picker is restricted to Call Scoring", async () => {
  expect(await (await run([opening, comparison], "Fahad", "calls")).text()).toContain("current access or source selection");
  expect(mocks.readPayroll).not.toHaveBeenCalled();
});

it("does not fall back to all teams when a team cannot be matched", async () => {
  const text = await (await run([opening, myTeam, comparison], "Unknown")).text();
  expect(text).toContain("Which Payroll team name should I use?");
  expect(text).not.toContain("report_scope");
});

it("anchors relative scopes to each turn when a conversation is reopened later", () => {
  const now = Date.parse("2026-12-02T12:00:00Z");
  const history = [
    user("Show Payroll show rate this week.", "2026-10-30T12:00:00Z"),
    user("Just Team Fahad"),
    user("Compare against 2026-10-22"),
  ];
  const result = resolveReportFollowup(history, timeZone, now);
  expect(result.scope).toMatchObject({
    range: { from: "2026-10-26", through: "2026-10-30" },
    comparison: { from: "2026-10-22", through: "2026-10-22" },
    team: { kind: "named", name: "Team Fahad" },
  });
});

it("remembers Call Scoring and resets on a new topic", () => {
  const ask = user("Show me this week’s call scores");
  expect(resolveReportFollowup([ask, comparison], timeZone).scope?.source).toBe("call-scoring");
  expect(resolveReportFollowup([ask, user("Write a welcome email"), comparison], timeZone).scope).toBeNull();
});

it("respects a later date or source override without carrying an old comparison", () => {
  const result = resolveReportFollowup([opening, myTeam, comparison, user("Same for yesterday"), user("Use GHL")], timeZone);
  expect(result.scope).toEqual({
    source: "crm", metric: "closings", team: { kind: "mine" },
    range: { from: "2026-11-17", through: "2026-11-17" },
  });
});

it("asks for exact dates when the original relative date cannot be anchored", async () => {
  const response = await run([{ role: "user", content: opening.content }, myTeam], "Fahad");
  const text = await response.text();
  expect(text).toContain("original date is unavailable");
  expect(text).not.toContain("report_scope");
  expect(mocks.readPayroll).not.toHaveBeenCalled();

  const explicit = resolveReportFollowup([
    { role: "user", content: opening.content },
    myTeam,
    user("From 2026-10-26 to 2026-10-29"),
  ], timeZone);
  expect(explicit.scope?.range).toEqual({ from: "2026-10-26", through: "2026-10-29" });
});

it("preserves the historical report scope when a project supplies shared files", async () => {
  const response = await POST(new Request("http://localhost/api/v1/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-chatbot-user-token": "test-session" },
    body: JSON.stringify({
      messages: [user("Show Payroll closings this week.", "2026-10-29T12:00:00Z"), myTeam],
      reportTeam: "Fahad",
      timeZone,
      projectFilesOnly: true,
      attachments: [{ name: "Project files", text: "Project instructions and reference material." }],
    }),
  }));
  const text = await response.text();
  expect(text).toContain('"team":"Team Fahad","from":"2026-10-26","through":"2026-10-29"');
  expect(mocks.readPayroll.mock.calls[0].slice(0, 4)).toEqual(["performance", "verified@example.test", "2026-10-26", "2026-10-29"]);
});
