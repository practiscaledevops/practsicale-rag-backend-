import {beforeEach,afterEach,describe,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({create:vi.fn(),options:vi.fn()}));
vi.mock("openai",()=>({default:class{embeddings={create:mocks.create};constructor(options:unknown){mocks.options(options);}}}));
vi.mock("@/lib/secrets",()=>({getProviderKey:async()=>"test-only-key"}));
vi.mock("@/lib/demo/mode",()=>({isDemo:()=>false}));
beforeEach(()=>{vi.resetModules();mocks.create.mockReset();mocks.options.mockReset();vi.stubEnv("EMBEDDINGS_STRICT","1");});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
describe("query embedding boundary",()=>{
 for(const [label,value] of [["short",[1,2,3]],["non-finite",Array(1024).fill(NaN)],["zero",Array(1024).fill(0)],["wrong type",Array(1024).fill("1")]]){
   it("rejects "+label+" vectors",async()=>{mocks.create.mockResolvedValue({data:[{index:0,embedding:value}]});const {embed}=await import("@/lib/embeddings");await expect(embed("query")).rejects.toThrow("invalid vector");});
 }
 it("uses a bounded provider timeout and accepts valid vectors",async()=>{
   const v=Array(1024).fill(.1);mocks.create.mockResolvedValue({data:[{index:0,embedding:v}]});
   const {embed}=await import("@/lib/embeddings");expect(await embed("query")).toEqual(v);
   expect(mocks.options).toHaveBeenCalledWith(expect.objectContaining({timeout:30000,maxRetries:0}));
 });
 it("keeps batch embeddings aligned with the original input",async()=>{
   const a=Array(1024).fill(.1),b=Array(1024).fill(.2);mocks.create.mockResolvedValue({data:[{index:1,embedding:b},{index:0,embedding:a}]});
   const {embedMany}=await import("@/lib/embeddings");expect(await embedMany(["a","b"])).toEqual([a,b]);
 });
 it("uses the explicit lexical fallback rather than a malformed vector",async()=>{
   vi.stubEnv("EMBEDDINGS_STRICT","0");vi.spyOn(console,"warn").mockImplementation(()=>{});
   mocks.create.mockResolvedValue({data:[]});const {embed}=await import("@/lib/embeddings");
   expect(await embed("query")).toEqual(Array(1024).fill(0));
 });
});
