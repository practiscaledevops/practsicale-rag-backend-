import { beforeEach, describe, expect, it, vi } from "vitest";
const m=vi.hoisted(()=>({admin:vi.fn(),from:vi.fn(),eq:vi.fn(),doc:{id:"doc",updated_at:"2026-10-20T13:38:42Z",source_type:"transcript"} as Record<string,unknown>|null}));
vi.mock("@/lib/auth/admin",async original=>({...await original<typeof import("@/lib/auth/admin")>(),requireAdmin:m.admin}));
vi.mock("@/lib/supabase",()=>({supabaseAdmin:()=>({from:m.from})}));
import { GET } from "@/app/api/admin/documents/[id]/route";
import { AdminAuthError } from "@/lib/auth/admin";
const request=()=>new Request("https://brain.test/api/admin/documents/doc?revision=2026-10-20T13%3A38%3A42Z");
const ctx=()=>({params:Promise.resolve({id:"doc"})});
beforeEach(()=>{
  vi.clearAllMocks();m.doc={id:"doc",updated_at:"2026-10-20T13:38:42Z",source_type:"transcript"};m.admin.mockResolvedValue({orgId:"server-tenant"});
  m.from.mockImplementation(()=>{const q:any={select:()=>q,eq:(...a:unknown[])=>{m.eq(...a);return q;},maybeSingle:async()=>({data:m.doc,error:null})};return q;});
});
describe("call inspector live revision",()=>{
  it("authenticates and scopes even unchanged metadata, without reading chunks",async()=>{
    const res=await GET(request(),ctx());expect(res.status).toBe(304);expect(res.headers.get("cache-control")).toContain("no-store");expect(await res.text()).toBe("");
    expect(m.admin).toHaveBeenCalledWith("documents:read");expect(m.eq).toHaveBeenCalledWith("org_id","server-tenant");expect(m.from).toHaveBeenCalledOnce();expect(m.from).toHaveBeenCalledWith("documents");
  });
  it("does not expose revision existence across tenant or permission boundaries",async()=>{
    m.doc=null;expect((await GET(request(),ctx())).status).toBe(404);
    m.from.mockClear();m.admin.mockRejectedValueOnce(new AdminAuthError("Forbidden",403));expect((await GET(request(),ctx())).status).toBe(403);expect(m.from).not.toHaveBeenCalled();
  });
});
