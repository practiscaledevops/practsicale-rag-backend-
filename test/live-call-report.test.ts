import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(()=>({ctx:vi.fn(),from:vi.fn(),roster:vi.fn(),version:"old",count:2,dbError:null as unknown,capabilities:["chat"],sourceTypes:[] as string[],collections:[] as string[], sources:[] as string[]}));
vi.mock("@/lib/auth/context",async importOriginal=>({...await importOriginal<typeof import("@/lib/auth/context")>(),resolveContext:m.ctx}));
vi.mock("@/lib/supabase",()=>({supabaseAdmin:()=>({from:m.from})}));
vi.mock("@/lib/call-review",async importOriginal=>({...await importOriginal<typeof import("@/lib/call-review")>(),knownConsultants:async()=>[],fetchCallsByFilter:m.roster}));
vi.mock("@/lib/ratelimit",()=>({checkRateLimit:()=>({ok:true}),rateLimitHeaders:()=>({})}));
import { POST } from "@/app/api/v1/call-reports/route";
import { AuthError } from "@/lib/auth/context";
const request=(body:Record<string,unknown>={})=>new Request("https://brain.test/api/v1/call-reports",{method:"POST",body:JSON.stringify({query:"check calls on 2026-10-20",timeZone:"Asia/Karachi",...body})});
beforeEach(()=>{
  vi.clearAllMocks(); m.version="old";m.count=2;m.dbError=null;m.capabilities=["chat"];m.sourceTypes=[];m.collections=[];m.sources=[];
  m.ctx.mockImplementation(async()=>({orgId:"tenant",key:{id:"key",capabilities:m.capabilities,source_types:m.sourceTypes,collection_ids:m.collections,data_source_ids:m.sources}}));
  m.from.mockImplementation(()=>{const q:any={select:()=>q,eq:vi.fn(()=>q),ilike:()=>q,or:()=>q,gte:()=>q,lte:()=>q,lt:()=>q,order:()=>q,limit:async()=>({data:[{id:"d",updated_at:m.version}],count:m.count,error:m.dbError})};return q;});
  m.roster.mockResolvedValue({scorecard:[],totalMatched:0,complete:true});
});
describe("live call reports",()=>{
  it("authenticates and refuses capabilities/source/collection scope widening before reading",async()=>{
    m.ctx.mockRejectedValueOnce(new AuthError("Unauthorized",401));expect((await POST(request())).status).toBe(401);
    m.capabilities=[];expect((await POST(request())).status).toBe(403);
    m.capabilities=["chat"];m.sourceTypes=["document"];expect((await POST(request())).status).toBe(403);
    m.sourceTypes=[];m.collections=["11111111-1111-4111-8111-111111111111"];expect((await POST(request())).status).toBe(403);
    m.collections=[];m.sources=["source"];expect((await POST(request())).status).toBe(403);
    m.sources=[];expect((await POST(request({capabilities:["chat.knowledge"]}))).status).toBe(403);
    expect(m.from).not.toHaveBeenCalled();
  });
  it("rejects unbounded and non-report queries",async()=>{
    expect((await POST(request({query:"x".repeat(8001)}))).status).toBe(400);
    expect((await POST(request({waitMs:20001}))).status).toBe(400);
    expect((await POST(request({query:"write a post about calls"}))).status).toBe(400);
  });
  it("uses server tenant/date filters, private caching and no roster read when unchanged",async()=>{
    const first=await POST(request());expect(first.headers.get("cache-control")).toContain("no-store");
    const data=await first.json();expect(data.version).toBeTruthy();expect(data.content).toContain("No matching calls");
    const q=m.from.mock.results[0].value;expect(q.eq).toHaveBeenCalledWith("org_id","tenant");
    m.roster.mockClear();const next=await (await POST(request({version:data.version}))).json();expect(next.unchanged).toBe(true);expect(m.roster).not.toHaveBeenCalled();
  });
  it("detects deletions and status revisions and retries an overlapping write",async()=>{
    const first=await (await POST(request())).json();m.count=1;
    expect((await (await POST(request({version:first.version}))).json()).version).not.toBe(first.version);
    m.roster.mockClear();m.roster.mockImplementationOnce(async()=>{m.version="new";return {scorecard:[],totalMatched:0,complete:true};});
    expect((await POST(request())).status).toBe(200);expect(m.roster).toHaveBeenCalledTimes(2);
  });
  it("returns unavailable rather than a fabricated zero report on database failure",async()=>{
    m.roster.mockResolvedValueOnce({scorecard:[],totalMatched:0,complete:false});expect((await POST(request())).status).toBe(503);
    m.dbError={message:"private database detail"};const res=await POST(request());expect(res.status).toBe(503);expect(await res.text()).not.toContain("private database");
  });
  it("waits for a changed revision and returns it without a fresh user request",async()=>{
    const first=await (await POST(request())).json();const pending=POST(request({version:first.version,waitMs:1500}));
    const change=setTimeout(()=>{m.version="changed";},30);
    const next=await (await pending).json();clearTimeout(change);expect(next.version).not.toBe(first.version);expect(next.unchanged).not.toBe(true);
  });
});
