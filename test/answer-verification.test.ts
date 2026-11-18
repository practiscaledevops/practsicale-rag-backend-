import { describe, expect, it, vi } from "vitest";
import { matchesRequestedVerbatimQuote, verifiedFactualAnswer, verifyAndRepairAnswer } from "@/lib/answer-verification";
describe("factual answer release gate",()=>{
  it("withholds unsupported facts and invented citation IDs",()=>{
    expect(verifiedFactualAnswer("Invented revenue",{checked:true,grounded:false,unsupported:["revenue"]},[]).text).not.toContain("Invented revenue");
    expect(verifiedFactualAnswer("Invented revenue",{checked:true,grounded:true,unsupported:[]},["fake"]).verified).toBe(false);
  });
  it("does not turn a failed or skipped verification into a pass",()=>{
    for(const verdict of [null,{checked:false,grounded:true,unsupported:[]}]) expect(verifiedFactualAnswer("unverified",verdict,[]).verified).toBe(false);
  });
  it("releases a checked answer without altering its facts",()=>{
    expect(verifiedFactualAnswer("Verified answer",{checked:true,grounded:true,unsupported:[]},[])).toMatchObject({text:"Verified answer",verified:true});
  });
  it("rechecks a correction and accounts for both verification calls",async()=>{
    const verify=vi.fn().mockResolvedValueOnce({checked:true,grounded:false,unsupported:["price"],usage:{model:"test",inputTokens:10,outputTokens:2,estimatedCostUsd:0.01}})
      .mockResolvedValueOnce({checked:true,grounded:true,unsupported:[],usage:{model:"test",inputTokens:12,outputTokens:1,estimatedCostUsd:0.02}});
    const repair=vi.fn().mockResolvedValue("Supported service; price unknown.");
    const r=await verifyAndRepairAnswer({text:"Invented price",verify,repair,fabricated:()=>[],canRepair:()=>true});
    expect(r).toMatchObject({verified:true,repaired:true,text:"Supported service; price unknown.",verdict:{usage:{inputTokens:22,outputTokens:3,estimatedCostUsd:0.03}}});
    expect(verify).toHaveBeenLastCalledWith("Supported service; price unknown.");
    expect(repair).toHaveBeenCalledTimes(1);
  });
  it("withholds a correction that fails its own verification",async()=>{
    const verify=vi.fn().mockResolvedValue({checked:true,grounded:false,unsupported:["claim"]});
    const repair=vi.fn().mockResolvedValue("Still invented");
    const r=await verifyAndRepairAnswer({text:"Invented",verify,repair,fabricated:()=>[],canRepair:()=>true});
    expect(r.verified).toBe(false); expect(r.text).not.toContain("Still invented"); expect(repair).toHaveBeenCalledTimes(1);
  });
  it("skips the judge on a fabricated citation and verifies the repaired claims", async () => {
    const draft = "Send a reminder a week ahead. [invented]";
    const corrected = "Send a reminder 24 hours ahead. [3b1aaf21]";
    const verify = vi.fn().mockResolvedValue({ checked: true, grounded: true, unsupported: [] });
    const repair = vi.fn().mockResolvedValue(corrected);
    const result = await verifyAndRepairAnswer({
      text: draft, verify, repair, canRepair: () => true,
      fabricated: text => text.includes("[invented]") ? ["invented"] : [],
    });
    expect(repair).toHaveBeenCalledWith(draft, [], ["invented"]);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(corrected);
    expect(result).toMatchObject({ text: corrected, verified: true });
  });
  it("withholds a repair that still cites an unknown source", async () => {
    const verify = vi.fn();
    const result = await verifyAndRepairAnswer({
      text: "Original draft.", verify, canRepair: () => true,
      repair: async () => "A rewritten draft. [unknown]",
      fabricated: () => ["unknown"],
    });
    expect(verify).not.toHaveBeenCalled();
    expect(result).toMatchObject({ verified: false, label: "Unsupported answer withheld" });
  });
  it("does not spend on a correction when verification is unavailable or the deadline is near",async()=>{
    for (const checked of [false,true]) {
      const repair=vi.fn();
      const r=await verifyAndRepairAnswer({text:"Draft",verify:async()=>({checked,grounded:false,unsupported:[]}),repair,fabricated:()=>[],canRepair:()=>!checked});
      expect(r.verified).toBe(false);expect(repair).not.toHaveBeenCalled();
    }
  });
});

describe("exact quotation verification", () => {
  const question = "Please quote the appointment reminder rule verbatim.";
  const source = {
    id: "3b1aaf21-7192-4dbf-91c1-95958bdf302b", source_type: "document",
    document_id: "policy", parent_id: null, metadata: {},
    content: "Send a reminder 24 hours before the appointment unless the client opted out. Use the confirmed channel.",
  };
  const answer = "> Send a reminder 24 hours before the appointment unless the client opted out. [3b1aaf21]";

  it("checks the complete sentence against its unique original citation", () => {
    expect(matchesRequestedVerbatimQuote(question, answer, [source])).toBe(true);
  });

  it("falls back to the full judge for missing qualifications, added claims, and ambiguous sources", () => {
    const changedAnswers = [
      answer.replace(" unless the client opted out", ""),
      answer.replace("24 hours", "48 hours"),
      answer + "\n\nThis increased conversion.",
      answer.replace("3b1aaf21", "not-a-source"),
    ];
    for (const changed of changedAnswers) expect(matchesRequestedVerbatimQuote(question, changed, [source])).toBe(false);
    expect(matchesRequestedVerbatimQuote(question, answer, [source, { ...source, id: "3b1aaf21-6192-4dbf-91c1-95958bdf302b" }])).toBe(false);
    expect(matchesRequestedVerbatimQuote("Summarize the reminder rule.", answer, [source])).toBe(false);
    expect(matchesRequestedVerbatimQuote(question, answer, [{ ...source, source_type: "call_score" }])).toBe(false);
  });
});
