import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ from: vi.fn(), insertError: null as null | {code:string}, source: true, replayRecord: "22222222-2222-4222-8222-222222222222", after: vi.fn() }));
vi.mock("next/server", () => ({ after: m.after }));
vi.mock("@/lib/connectors/scoring-events", () => ({ drainScoringEvents: vi.fn(async () => 0) }));
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => ({ from: m.from }) }));
import { POST } from "@/app/api/webhooks/call-scoring/[sourceId]/route";
const SOURCE = "11111111-1111-4111-8111-111111111111";
const REPORT = "22222222-2222-4222-8222-222222222222";
const EVENT = "33333333-3333-4333-8333-333333333333";
const SECRET = "integration-test-secret-at-least-32-characters";
function request(body: string, timestamp=String(Math.floor(Date.now()/1000)), signature?: string) {
  return new Request("http://localhost/api/webhooks/call-scoring/"+SOURCE, { method:"POST", body,
    headers:{"x-brain-timestamp":timestamp,"x-brain-signature":signature??`v1=${createHmac("sha256",SECRET).update(`${timestamp}.${body}`).digest("hex")}`} });
}
const payload = () => JSON.stringify({ event_id:EVENT,report_id:REPORT,updated_at:new Date().toISOString() });
const call = (req:Request) => POST(req,{params:Promise.resolve({sourceId:SOURCE})});
beforeEach(() => {
  vi.stubEnv("SCORING_WEBHOOK_SECRET",SECRET); vi.clearAllMocks(); m.insertError=null;m.source=true;m.replayRecord=REPORT;
  m.from.mockImplementation((table:string) => {
    const q:any = { select:()=>q,eq:()=>q,insert:vi.fn(async()=>({error:m.insertError})),maybeSingle:async()=>({data:table==="data_sources"?(m.source?{id:SOURCE,org_id:"server-org"}:null):{data_source_id:SOURCE,record_id:m.replayRecord,status:"pending"},error:null}) };
    return q;
  });
});
afterEach(()=>vi.unstubAllEnvs());
describe("scoring webhook",()=>{
  it("rejects forged and expired deliveries before any DB work",async()=>{
    expect((await call(request(payload(),undefined,"v1="+"0".repeat(64)))).status).toBe(401);
    expect((await call(request(payload(),String(Math.floor(Date.now()/1000)-301)))).status).toBe(401);
    expect(m.from).not.toHaveBeenCalled();
  });
  it("rejects signed malformed JSON, foreign org fields and oversized bodies",async()=>{
    expect((await call(request("{"))).status).toBe(400);
    expect((await call(request(JSON.stringify({...JSON.parse(payload()),org_id:"foreign"})))).status).toBe(400);
    expect((await call(request("x".repeat(4097)))).status).toBe(413);
  });
  it("durably accepts IDs using only the registered source's org",async()=>{
    const res=await call(request(payload()));expect(res.status).toBe(202);
    expect(await res.json()).toEqual({accepted:true,event_id:EVENT});
    const q=m.from.mock.results.find((_,i)=>m.from.mock.calls[i][0]==="scoring_sync_events")!.value;
    expect(q.insert).toHaveBeenCalledWith({id:EVENT,org_id:"server-org",data_source_id:SOURCE,record_id:REPORT});
    expect(m.after).toHaveBeenCalledOnce();
  });
  it("does not acknowledge an undurable delivery",async()=>{m.insertError={code:"unavailable"};expect((await call(request(payload()))).status).toBe(503);expect(m.after).not.toHaveBeenCalled();});
  it("accepts replays but rejects an event-id collision for another call",async()=>{
    m.insertError={code:"23505"};expect((await call(request(payload()))).status).toBe(202);
    m.replayRecord="44444444-4444-4444-8444-444444444444";expect((await call(request(payload()))).status).toBe(409);
  });
  it("does not accept an unknown or inactive source",async()=>{m.source=false;expect((await call(request(payload()))).status).toBe(404);});
});
