import {beforeEach,describe,expect,it,vi} from "vitest";
const generate=vi.hoisted(()=>vi.fn());
vi.mock("ai",()=>({generateText:generate}));
vi.mock("@/lib/llm",()=>({getModel:async()=>({modelId:"gpt-6-luna"})}));
vi.mock("@/lib/demo/mode",()=>({isDemo:()=>false}));
import {checkFaithfulness} from "@/lib/faithfulness";
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
