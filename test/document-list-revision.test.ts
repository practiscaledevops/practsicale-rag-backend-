import { beforeEach, describe, expect, it, vi } from "vitest";
const m=vi.hoisted(()=>({admin:vi.fn(),count:0,latest:null as null|{id:string;updated_at:string},dbError:null as unknown,eq:vi.fn(),from:vi.fn()}));
vi.mock("@/lib/auth/admin",async original=>({...await original<typeof import("@/lib/auth/admin")>(),requireAdmin:m.admin}));
vi.mock("@/lib/supabase",()=>({supabaseAdmin:()=>({from:m.from})}));
import { GET } from "@/app/api/admin/documents/revision/route";
import { AdminAuthError } from "@/lib/auth/admin";
beforeEach(()=>{vi.clearAllMocks();m.count=0;m.latest=null;m.dbError=null;m.admin.mockResolvedValue({orgId:"server-tenant"});m.from.mockImplementation(()=>{const q:any={select:()=>q,eq:(...args:unknown[])=>{m.eq(...args);return q;},order:()=>q,limit:async()=>({data:m.latest?[m.latest]:[],count:m.count,error:m.dbError})};return q;});});
describe("live Brain document list",()=>{
  it("detects the first new document, later updates and deletion without listing document bodies",async()=>{
    const empty=await (await GET()).json();m.count=1;m.latest={id:"new",updated_at:"2026-10-20T14:00:00Z"};const inserted=await (await GET()).json();expect(inserted.version).not.toBe(empty.version);
    m.latest.updated_at="2026-10-20T14:01:00Z";const updated=await (await GET()).json();expect(updated.version).not.toBe(inserted.version);
    m.count=0;m.latest=null;const deleted=await (await GET()).json();expect(deleted.version).toBe(empty.version);expect(m.eq).toHaveBeenCalledWith("org_id","server-tenant");
  });
  it("checks document permissions on every poll and keeps revisions private",async()=>{
    m.admin.mockRejectedValueOnce(new AdminAuthError("Forbidden",403));expect((await GET()).status).toBe(403);expect(m.from).not.toHaveBeenCalled();
    const res=await GET();expect(res.headers.get("cache-control")).toContain("no-store");
    m.dbError={message:"private"};const failed=await GET();expect(failed.status).toBe(503);expect(await failed.text()).not.toContain("private");
  });
});
