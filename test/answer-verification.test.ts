import { describe, expect, it } from "vitest";
import { verifiedFactualAnswer } from "@/lib/answer-verification";
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
});
