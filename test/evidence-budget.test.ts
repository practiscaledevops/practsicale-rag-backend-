import {describe,it,expect} from "vitest";
import {budgetEvidence} from "@/lib/evidence-diversity";

describe("expanded evidence budget",()=>{
  it("keeps complete passages and their ranking inside the real text limit",()=>{
    const chunks=Array.from({length:100},(_,i)=>({id:`c${i}`,content:"x".repeat(2000),metadata:{tokens:1}}));
    const result=budgetEvidence(chunks,6000);
    expect(result.map(c=>c.id)).toEqual(["c0","c1","c2"]);
    expect(result.reduce((n,c)=>n+c.content.length,0)).toBeLessThanOrEqual(6000);
  });
  it("marks an oversized first source as an excerpt and leaves space for other evidence",()=>{
    const result=budgetEvidence([{id:"large",content:"Evidence. ".repeat(10000)},{id:"policy",content:"The current guarantee is conditional."}],15000);
    expect(result.map(c=>c.id)).toEqual(["large","policy"]);
    expect(result[0].content).toContain("remaining source was not supplied");
    expect(result.reduce((n,c)=>n+c.content.length,0)).toBeLessThanOrEqual(15000);
  });
  it("does not duplicate expanded parent chunks",()=>{
    expect(budgetEvidence([{id:"a",content:"one"},{id:"a",content:"one"}])).toHaveLength(1);
  });
});
