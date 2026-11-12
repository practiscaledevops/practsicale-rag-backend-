import { describe, expect, it, vi } from "vitest";
import { verifiedFactualAnswer, verifyAndRepairAnswer } from "@/lib/answer-verification";
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
  it("does not spend on a correction when verification is unavailable or the deadline is near",async()=>{
    for (const checked of [false,true]) {
      const repair=vi.fn();
      const r=await verifyAndRepairAnswer({text:"Draft",verify:async()=>({checked,grounded:false,unsupported:[]}),repair,fabricated:()=>[],canRepair:()=>!checked});
      expect(r.verified).toBe(false);expect(repair).not.toHaveBeenCalled();
    }
  });
});
