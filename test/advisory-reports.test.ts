import {it,expect,vi,afterEach} from 'vitest';
const m=vi.hoisted(()=>({identity:vi.fn(),read:vi.fn()}));
vi.mock('@/lib/connectors/source-access',()=>({requireSourceIdentity:m.identity}));
vi.mock('@/lib/connectors/payroll-live',()=>({readLivePayroll:m.read}));
import {readAdvisoryReports} from '@/lib/connectors/advisory-reports';
const plan={reports:['performance','rules'] as ('performance'|'rules')[],from:'2026-11-01',through:'2026-11-17'};
const signal=()=>new AbortController().signal;
afterEach(()=>{vi.useRealTimers();vi.resetAllMocks();});
it('authenticates once per request and reads reports in parallel, preserving every report',async()=>{
 vi.useFakeTimers();m.identity.mockImplementation(()=>new Promise(r=>setTimeout(()=>r('verified@example.com'),200)));
 m.read.mockImplementation((report)=>new Promise(r=>setTimeout(()=>r({report,data:{completeMetric:42}}),300)));
 const start=Date.now(),pending=readAdvisoryReports('Analyze our Payroll rules',plan,'token',signal());
 await vi.advanceTimersByTimeAsync(199);expect(m.read).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(1);expect(m.read).toHaveBeenCalledTimes(2);
 expect(m.read.mock.calls.every(c=>c[1]==='verified@example.com'&&c[2]===plan.from&&c[3]===plan.through)).toBe(true);
 await vi.advanceTimersByTimeAsync(300);const rows=await pending;
 expect(Date.now()-start).toBe(500);expect(rows).toHaveLength(2);expect(rows.every(r=>r.available)).toBe(true);expect(m.identity).toHaveBeenCalledTimes(1);
 const again=readAdvisoryReports('Analyze Payroll',plan,'different-token',signal());await vi.advanceTimersByTimeAsync(500);await again;expect(m.identity).toHaveBeenCalledTimes(2);
});
it('never reads a report for invalid identity and preserves per-report permission denial as unavailable',async()=>{
 m.identity.mockRejectedValueOnce(new Error('denied'));const denied=await readAdvisoryReports('Payroll',plan,'bad',signal());expect(m.read).not.toHaveBeenCalled();expect(denied.every(r=>!r.available)).toBe(true);
 m.identity.mockResolvedValue('verified@example.com');m.read.mockImplementation(async report=>{if(report==='rules')throw new Error('source permission denied');return {report,data:{value:10}}});
 const partial=await readAdvisoryReports('Payroll',plan,'good',signal());expect(partial.map(r=>r.available)).toEqual([true,false]);expect(JSON.stringify(partial[1])).toContain('not zero');
});
it('keeps cancellation and unsupported periods out of provider work',async()=>{
 const controller=new AbortController();controller.abort();m.identity.mockResolvedValue('verified@example.com');await expect(readAdvisoryReports('Payroll',plan,'token',controller.signal)).rejects.toThrow();expect(m.read).not.toHaveBeenCalled();
 expect(await readAdvisoryReports('Hourly',{...plan,unsupported:'day only'},'token',signal())).toEqual([]);
});
