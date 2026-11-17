import { afterEach, expect, it, vi } from 'vitest';
import { planPayrollReports, readLivePayroll } from '@/lib/connectors/payroll-live';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
it('routes fines and bonuses separately from sales',()=>{
 expect(planPayrollReports('Compare fines and bonuses for November 2026','Asia/Karachi')?.reports).toEqual(['fines','bonuses']);
});
it('never silently rounds hourly requests to a month',()=>{
 expect(planPayrollReports('Show sales in the last 1 hour','Asia/Karachi')?.unsupported).toContain('hourly');
});
it('keeps ordinary writing off the live payroll path',()=>{
 expect(planPayrollReports('Write a welcome email','Asia/Karachi')).toBeNull();
});
it('requires a bridge key',async()=>{
 vi.stubEnv('PAYROLL_BRIDGE_KEY',''); const f=vi.fn();vi.stubGlobal('fetch',f);
 await expect(readLivePayroll('rules','a@b.com','2026-11-01','2026-11-17',new AbortController().signal)).rejects.toThrow();expect(f).not.toHaveBeenCalled();
});
it('rejects mismatched or partial source reports',async()=>{
 vi.stubEnv('PAYROLL_BRIDGE_KEY','test'); vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({ report:'people',from:'2026-11-01',through:'2026-11-17',date_basis:'now',fetched_at:'now',source:'Sales Payroll',complete:true,warnings:[],data:[] })));
 await expect(readLivePayroll('rules','a@b.com','2026-11-01','2026-11-17',new AbortController().signal)).rejects.toThrow('scope');
});

it('uses current roster for setter headcount, not activity or closing participation',()=>{ expect(planPayrollReports('How many setters are there currently in Practiscale','Asia/Karachi')?.reports).toEqual(['people']); });
