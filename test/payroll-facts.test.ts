import {expect,it} from 'vitest';
import {renderPayrollFacts} from '@/lib/connectors/payroll-facts';
const base={from:'2026-11-01',through:'2026-11-17',date_basis:'Current roster',fetched_at:'2026-11-17T15:00:00Z'};
it('counts active sales roles and excludes inactive rows',()=>{const s=renderPayrollFacts('How many active setters?',{...base,report:'people',data:{active:2,people:[{name:'A',role:'setter',status:'active'},{name:'B',role:'setter',status:'inactive'},{name:'C',role:'consultant',status:'active'}]}});expect(s).toContain('| setter | 1 |');expect(s).toContain('**2**');});
it('does not pass a current roster off as historical',()=>{expect(renderPayrollFacts('How many setters last month?',{...base,report:'people',data:{}})).toBeNull();});
it('does not invent a best-person ranking',()=>{expect(renderPayrollFacts('Who is the best setter?',{...base,report:'people',data:{}})).toBeNull();});
it('separates confirmed and pending money and converts minor units',()=>{const s=renderPayrollFacts('Give total fines summary for November',{...base,report:'fines',data:[{status:'confirmed',amount_minor:150000},{status:'pending',amount_minor:200000}]});expect(s).toContain('| confirmed | 1 | 1,500.00 |');expect(s).toContain('| pending | 1 | 2,000.00 |');});
it('does not replace a named-person fine question with company totals',()=>{expect(renderPayrollFacts('Show total fines for David Miller',{...base,report:'fines',data:[]})).toBeNull();});
it('refuses malformed source records rather than counting them as zero',()=>{expect(()=>renderPayrollFacts('How many setters?',{...base,report:'people',data:{}})).toThrow();});
