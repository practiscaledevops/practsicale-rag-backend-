import {it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({access:vi.fn(),hour:vi.fn(),model:vi.fn()}));
vi.mock('@/lib/auth/context',()=>({resolveContext:async()=>({orgId:'org',key:{id:crypto.randomUUID(),capabilities:['chat'],rate_limit_per_min:100,source_types:[],data_source_ids:[],collection_ids:[]}})}));
vi.mock('@/lib/connectors/payroll-report',()=>({payrollAccess:()=>true}));
vi.mock('@/lib/connectors/source-access',()=>({requireSourcePermission:m.access}));
vi.mock('@/lib/connectors/exact-report',()=>({reportingWindow:()=>({start:'2026-11-16T15:00:00Z',end:'2026-11-16T16:00:00Z'}),hourlyReport:m.hour}));
vi.mock('@/lib/llm',()=>({getModel:m.model}));
import {POST} from '@/app/api/v1/chat/route';
const request=()=>new Request('http://localhost/api/v1/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'Appointments from 20:00 to 21:00 on 2026-11-16'}],capabilities:['chat.knowledge','chat.call_review'],timeZone:'Asia/Karachi'})});
it('streams progress before the source finishes and never invokes a model',async()=>{
 let release!:(s:string)=>void;m.access.mockImplementationOnce(()=>new Promise<string>(r=>{release=r}));m.hour.mockResolvedValueOnce('13 appointments');
 const response=await POST(request());const reader=response.body!.getReader();const first=new TextDecoder().decode((await reader.read()).value);expect(first).toContain('Checking your access');release('verified@example.com');let rest='';for(;;){const r=await reader.read();if(r.done)break;rest+=new TextDecoder().decode(r.value);}expect(rest).toContain('13 appointments');expect(rest).toContain('Report complete');expect(m.model).not.toHaveBeenCalled();
});
it('finishes a failed source request with recoverable state and permits a clean retry',async()=>{
 m.access.mockResolvedValue('verified@example.com');m.hour.mockRejectedValueOnce(new DOMException('Timed out','TimeoutError'));
 const failed=await (await POST(request())).text();expect(failed).toContain('report_error');expect(failed).not.toContain('Report complete');expect(failed).toContain('no totals produced');
 m.hour.mockResolvedValueOnce('13 appointments');const retried=await (await POST(request())).text();expect(retried).toContain('13 appointments');expect(retried).not.toContain('report_error');expect(m.model).not.toHaveBeenCalled();
});

vi.mock('@/lib/ratelimit',()=>({checkRateLimit:async()=>({ok:true}),rateLimitHeaders:()=>({})}));

it('never finishes a null report as an empty loading response',async()=>{m.access.mockResolvedValue('verified@example.com');m.hour.mockResolvedValueOnce(null);const body=await(await POST(request())).text();expect(body).toContain('Report scope needs clarification');expect(body).toContain('No company-wide or zero total');expect(body).toContain('finishReason');});
