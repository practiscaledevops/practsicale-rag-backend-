import { afterEach, expect, it, vi } from "vitest";
import { requireSourcePermission, requireSourceIdentity } from "@/lib/connectors/source-access";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const signal = new AbortController().signal;
const id = "00000000-0000-4000-8000-000000000001";
function setup(overrides: { confirmed?: boolean; active?: boolean; sourceActive?: boolean; permissions?: string[]; chatbotRole?: string } = {}) {
  vi.stubEnv("CHATBOT_AUTH_URL", "https://fixture.supabase.co");
  vi.stubEnv("CHATBOT_AUTH_PUBLISHABLE_KEY", "public-fixture");
  vi.stubEnv("PAYROLL_REPORTS_SERVER_KEY", "fixture");
  const f = vi.fn().mockResolvedValueOnce(Response.json({ id, email: "person@example.com", email_confirmed_at: overrides.confirmed === false ? null : "2026-01-01" }))
    .mockResolvedValueOnce(Response.json([{ is_active: overrides.active ?? true, role: overrides.chatbotRole }]))
    .mockResolvedValueOnce(Response.json([{ role: "admin", role_id: id, active: overrides.sourceActive ?? true,admin_roles:{permissions:overrides.permissions??["dashboard.view"]} }]));
  vi.stubGlobal("fetch", f); return f;
}
it("does not contact any source without a user token", async () => {
  const f = setup(); await expect(requireSourcePermission(null, "dashboard.view", signal)).rejects.toThrow(); expect(f).not.toHaveBeenCalled();
});
it("checks verified identity and live permissions before granting reporting", async () => {
  const f=setup(); await expect(requireSourcePermission("session", "dashboard.view", signal)).resolves.toBe("person@example.com");
  expect(f.mock.calls[0][0]).toBe("https://fixture.supabase.co/auth/v1/user");
  expect(f.mock.calls[2][0]).toContain("person%40example.com");
});
it.each([{ confirmed:false }, { active:false }, { sourceActive:false }, { permissions:[] }])("fails closed for inactive, unverified or unprivileged users: %j", async input => {
  setup(input); await expect(requireSourcePermission("session", "dashboard.view", signal)).rejects.toThrow();
});
it("sales access does not grant pipeline access", async () => {
  setup(); await expect(requireSourcePermission("session", "pipeline.view", signal)).rejects.toThrow();
});
it("source administrator can access pipeline", async () => {
  setup({permissions:["*"]}); await expect(requireSourcePermission("session", "pipeline.view", signal)).resolves.toBe("person@example.com");
});

it("uses only an operator-configured alias bound to the verified user ID", async () => {
  const f=setup(); vi.stubEnv("SOURCE_ACCOUNT_ALIASES", JSON.stringify({[id]:"source@example.com"}));
  await requireSourcePermission("session", "dashboard.view", signal);
  expect(f.mock.calls[2][0]).toContain("source%40example.com");
});
it("fails closed on malformed alias configuration", async () => {
  setup(); vi.stubEnv("SOURCE_ACCOUNT_ALIASES", "not-json");
  await expect(requireSourcePermission("session", "dashboard.view", signal)).rejects.toThrow();
});

it('checks every requested source permission',async()=>{setup({permissions:['dashboard.view']});await expect(requireSourcePermission('session',['dashboard.view','pipeline.view'],signal)).rejects.toThrow();});
it('gateway identity checks active verified user without caching grants',async()=>{const f=setup();await expect(requireSourceIdentity('session',signal)).resolves.toBe('person@example.com');expect(f).toHaveBeenCalledTimes(2);});

it('overlaps independent permission reads but never grants access before active-profile validation',async()=>{
 setup();let release!:(r:Response)=>void;const f=vi.fn().mockResolvedValueOnce(Response.json({id,email:'person@example.com',email_confirmed_at:'2026-01-01'})).mockImplementationOnce(()=>new Promise<Response>(r=>{release=r})).mockResolvedValueOnce(Response.json([{role:'admin',role_id:null,active:true,admin_roles:null}]));vi.stubGlobal('fetch',f);
 let settled=false;const result=requireSourcePermission('session','dashboard.view',signal).finally(()=>{settled=true});const rejected=expect(result).rejects.toThrow('denied');
 await vi.waitFor(()=>expect(f).toHaveBeenCalledTimes(3));expect(settled).toBe(false);release(Response.json([{is_active:false}]));await rejected;
});

it("requires a current chatbot admin role for the company-wide review", async () => {
  setup({ chatbotRole: "user", permissions: ["reporting.view"] });
  await expect(requireSourcePermission("session", "reporting.view", signal, { adminOnly: true })).rejects.toThrow("denied");
  setup({ chatbotRole: "super_admin", permissions: ["reporting.view"] });
  await expect(requireSourcePermission("session", "reporting.view", signal, { adminOnly: true })).resolves.toBe("person@example.com");
});
