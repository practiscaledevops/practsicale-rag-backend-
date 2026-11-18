import {beforeEach,describe,expect,it,vi} from "vitest";
const generate=vi.hoisted(()=>vi.fn());
const resolve=vi.hoisted(()=>vi.fn(async()=>({modelId:"gpt-6-luna"})));
vi.mock("ai",()=>({generateText:generate}));
vi.mock("@/lib/llm",()=>({getModel:resolve}));
vi.mock("@/lib/demo/mode",()=>({isDemo:()=>false}));
import {checkFaithfulness, documentVerificationPolicy} from "@/lib/faithfulness";
import {FAITHFULNESS_SYSTEM, GROUNDED_SYSTEM, PRACTISCALE_IDENTITY} from "@/lib/prompts";
describe("verification uses the same task and approved policy as the answer",()=>{
 beforeEach(()=>generate.mockReset());
 it("checks a proposed answer even when no company evidence is available",async()=>{
  generate.mockResolvedValue({text:'{"grounded":true,"unsupported":[]}'});
  const verdict=await checkFaithfulness("","Proposed checklist","Verify claims","fast",undefined,{question:"Propose a checklist",trustedPolicy:"Assistant identity and approved definitions"});
  expect(verdict).toEqual({checked:true,grounded:true,unsupported:[]});
  const input=JSON.parse(generate.mock.calls[0][0].prompt);
  expect(input).toMatchObject({context:"",userTask:"Propose a checklist",applicationPolicy:"Assistant identity and approved definitions"});
 });
 it("does not certify a failed, malformed, or contradictory check",async()=>{
  for(const text of ['not JSON','{"grounded":true,"unsupported":["invented revenue"]}']){
   generate.mockResolvedValue({text});
   const verdict=await checkFaithfulness("evidence","answer","Verify claims");
   expect(verdict.checked&&verdict.grounded).toBe(false);
  }
 });
});

it('reuses the request model and still checks all supplied evidence before certifying',async()=>{
 resolve.mockClear();generate.mockResolvedValue({text:'{"grounded":false,"unsupported":["wrong total"]}'});
 const model={modelId:'gpt-6-luna'} as any;
 const verdict=await checkFaithfulness('fresh source scope','wrong total','policy','gpt-6-luna',undefined,{question:'shorten this',trustedPolicy:'grounding'},model);
 expect(resolve).not.toHaveBeenCalled();expect(generate.mock.calls.at(-1)![0].model).toBe(model);expect(verdict.grounded).toBe(false);expect(verdict.checked).toBe(true);
});

describe("ordinary factual verification", () => {
  const context = "[a] Current document: 24 hours.\n[b] Archived document: 6 hours.";
  const question = "What is the current reminder policy?";
  const answer = "Send the first reminder 24 hours in advance. [a]";
  const trustedPolicy = "Full application policy, including presentation and work mode.";
  const task = { question, trustedPolicy, documentLookupPolicy: documentVerificationPolicy(GROUNDED_SYSTEM) };
  const accepted = '{"grounded":true,"unsupported":[]}';

  beforeEach(() => generate.mockReset());

  it("sends every source, the question and the unmodified draft to the same model", async () => {
    const model = { modelId: "gpt-6-luna" } as Awaited<ReturnType<typeof import("@/lib/llm").getModel>>;
    generate.mockResolvedValue({ text: accepted });
    const verdict = await checkFaithfulness(context, answer, FAITHFULNESS_SYSTEM, "fast", undefined, task, model);
    expect(verdict).toMatchObject({ checked: true, grounded: true });
    expect(generate).toHaveBeenCalledTimes(1);
    const input = generate.mock.calls[0][0];
    expect(input.model).toBe(model);
    expect(JSON.parse(input.prompt)).toEqual({ applicationPolicy: task.documentLookupPolicy, context, userTask: question, answer });
    expect(task.documentLookupPolicy).toContain(PRACTISCALE_IDENTITY);
    expect(task.documentLookupPolicy).toContain("Closed / (Closed + Not Closed)");
  });

  it("retains the full custom verifier and every custom company rule", async () => {
    const customPolicy = "Appointments are scheduled in Pakistan time. The intake window is 15 minutes.";
    expect(documentVerificationPolicy(customPolicy)).toContain(customPolicy);
    generate.mockResolvedValue({ text: accepted });
    await checkFaithfulness(context, answer, "Custom organisation verifier", "fast", undefined, task);
    expect(generate).toHaveBeenCalledTimes(1);
    const input = generate.mock.calls[0][0];
    expect(input.system).toContain("Custom organisation verifier");
    expect(JSON.parse(input.prompt).applicationPolicy).toBe(trustedPolicy);
  });

  it("retries an unreadable compact verdict with the full prompt and meters both calls", async () => {
    generate.mockResolvedValueOnce({ text: "Unparseable", usage: { promptTokens: 100, completionTokens: 8 } })
      .mockResolvedValueOnce({ text: accepted, usage: { promptTokens: 200, completionTokens: 10 } });
    const verdict = await checkFaithfulness(context, answer, FAITHFULNESS_SYSTEM, "fast", undefined, task);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(JSON.parse(generate.mock.calls[1][0].prompt)).toEqual({ applicationPolicy: trustedPolicy, userTask: question, context, answer });
    expect(verdict).toMatchObject({ checked: true, grounded: true, usage: { inputTokens: 300, outputTokens: 18 } });
  });

  it("preserves a negative verdict and withholds certification if the fallback also fails", async () => {
    generate.mockResolvedValueOnce({ text: '{"grounded":false,"unsupported":["6 hours is outdated"]}' });
    const rejected = await checkFaithfulness(context, "Send it 6 hours ahead. [b]", FAITHFULNESS_SYSTEM, "fast", undefined, task);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(rejected).toMatchObject({ checked: true, grounded: false });

    generate.mockResolvedValue({ text: "Unparseable" });
    const unavailable = await checkFaithfulness(context, answer, FAITHFULNESS_SYSTEM, "fast", undefined, task);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(unavailable.checked).toBe(false);
  });

  it("checks each original cited statement with all of the evidence", async () => {
    const first = "The reminder starts 24 hours ahead [3b1aaf21].";
    const second = "Unconfirmed appointments get a second reminder. [8cd8e503]";
    generate.mockResolvedValue({ text: JSON.stringify([
      { number: 1, claim: first, finding: "24 hours", supported: true },
      { number: 2, claim: second, finding: "conditional second reminder", supported: true },
    ]) });
    const verdict = await checkFaithfulness(context, first + " " + second, FAITHFULNESS_SYSTEM, "fast", undefined, task);
    expect(verdict).toMatchObject({ checked: true, grounded: true, unsupported: [] });
    expect(JSON.parse(generate.mock.calls[0][0].prompt)).toMatchObject({
      claims: [{ number: 1, claim: first }, { number: 2, claim: second }], evidence: context,
    });
  });

  it("includes uncited trailing claims and reports the original text of a rejection", async () => {
    const cited = "The first reminder is sent 24 hours ahead. [3b1aaf21]";
    const tail = "This doubles conversion.";
    generate.mockResolvedValue({ text: JSON.stringify({ checks: [
      { number: 1, claim: cited, finding: "24 hours", supported: true },
      { number: 2, claim: tail, finding: "no conversion evidence", supported: false },
    ] }) });
    const verdict = await checkFaithfulness(context, cited + "\n" + tail, FAITHFULNESS_SYSTEM, "fast", undefined, task);
    expect(verdict).toMatchObject({ checked: true, grounded: false, unsupported: [tail] });
  });

  it("uses the intact-answer check when a statement is omitted or silently corrected", async () => {
    const wrong = "For this cohort, 18 of 24 appointments were attended, a 65% rate. [7fc78cab]";
    for (const checks of [[], [{ number: 1, claim: wrong.replace("65%", "75%"), supported: true }]]) {
      generate.mockReset().mockResolvedValueOnce({ text: JSON.stringify({ checks }) })
        .mockResolvedValueOnce({ text: '{"grounded":false,"unsupported":["65%"]}' });
      const verdict = await checkFaithfulness(context, wrong, FAITHFULNESS_SYSTEM, "fast", undefined, task);
      expect(verdict).toMatchObject({ checked: true, grounded: false });
      expect(JSON.parse(generate.mock.calls[0][0].prompt).claims[0].arithmetic).toEqual({
        numerator: 18, denominator: 24, computedPercent: 75, claimedPercent: 65,
      });
      expect(JSON.parse(generate.mock.calls[1][0].prompt).answer).toBe(wrong);
    }
  });

  it("keeps literal formulas together for comparison with the source", async () => {
    const formula = "Divide scheduled appointments by attended appointments. [7fc78cab]";
    generate.mockResolvedValue({ text: '{"grounded":false,"unsupported":["reversed formula"]}' });
    await checkFaithfulness(context, formula, FAITHFULNESS_SYSTEM, "fast", undefined, task);
    expect(JSON.parse(generate.mock.calls[0][0].prompt)).toMatchObject({ answer: formula, context });
  });
});
