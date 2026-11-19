import {expect,it} from 'vitest';
import {renderPayrollFacts} from '@/lib/connectors/payroll-facts';
const base={from:'2026-11-01',through:'2026-11-17',date_basis:'Current roster',fetched_at:'2026-11-17T15:00:00Z'};
it('counts active sales roles and excludes inactive rows',()=>{const s=renderPayrollFacts('How many active setters?',{...base,report:'people',data:{active:2,people:[{name:'A',role:'setter',status:'active'},{name:'B',role:'setter',status:'inactive'},{name:'C',role:'consultant',status:'active'}]}});expect(s).toContain('| setter | 1 |');expect(s).toContain('**2**');});
it('does not pass a current roster off as historical',()=>{expect(renderPayrollFacts('How many setters last month?',{...base,report:'people',data:{}})).toBeNull();});
it('does not invent a best-person ranking',()=>{expect(renderPayrollFacts('Who is the best setter?',{...base,report:'people',data:{}})).toBeNull();});
it('separates confirmed and pending money and converts minor units',()=>{const s=renderPayrollFacts('Give total fines summary for November',{...base,report:'fines',data:[{status:'confirmed',amount_minor:150000},{status:'pending',amount_minor:200000}]});expect(s).toContain('| confirmed | 1 | 1,500.00 |');expect(s).toContain('| pending | 1 | 2,000.00 |');});
it('does not replace a named-person fine question with company totals',()=>{expect(renderPayrollFacts('Show total fines for David Miller',{...base,report:'fines',data:[]})).toBeNull();});
it('refuses malformed source records rather than counting them as zero',()=>{expect(()=>renderPayrollFacts('How many setters?',{...base,report:'people',data:{}})).toThrow();});
const performance={...base,report:'performance',data:{summary:{booked:10,showed:5,no_show:3,closings:2,usd_minor:150000,absent_shows:null},setters:[],teams:[],consultants:[],niches:[],undated_entries:1,sales:[{client:'Client A',owner:'Owner A',ticket:'high_ticket',usd_minor:100000,recorded_date:null,niche:'Home care'},{client:'Client B',owner:'Owner B',ticket:'low_ticket',usd_minor:50000,recorded_date:'2026-11-12',niche:null}]}};
it('filters high-ticket source rows and keeps missing dates explicit',()=>{const s=renderPayrollFacts('List HT client names',performance);expect(s).toContain('1 closings · USD 1000.00');expect(s).toContain('Client A');expect(s).not.toContain('Client B');expect(s).toContain('Not recorded');});
it('ranks consultant niches by explicit USD rather than invented quality',()=>{const s=renderPayrollFacts('Which consultant is best by taxonomy?',performance);expect(s).toContain('Home care');expect(s).toContain('not establish coaching quality');});
it('never calls an unscanned employee absent',()=>{const s=renderPayrollFacts('Show attendance today',{...base,report:'attendance',data:{date:'2026-11-17',counts:{not_scanned_yet:5},unmeasurable:2}});expect(s).toContain('does not prove absence');});

const pay={...base,report:'payroll',data:{bill:{people:[{employee_id:'1',name:'David M',role:'consultant',minor:12500000},{employee_id:'2',name:'Kate Melody',role:'consultant',minor:9800000}],run_status:'open',last_recalculated_at:null,composition_reconciles:true}}};
it('answers named earnings from payslip minor units, not closed revenue',()=>{const a=renderPayrollFacts('how much david made earned this month',pay);expect(a).toContain('David M');expect(a).toContain('PKR 125,000.00');expect(a).toContain('whole-month');expect(a).not.toContain('Kate Melody');});
it('never guesses among two David payslips',()=>{const a=renderPayrollFacts('how much david earned this month',{...pay,data:{bill:{...pay.data.bill,people:[...pay.data.bill.people,{employee_id:'3',name:'David Jones',role:'consultant',minor:500}]}}});expect(a).toContain('Which person');expect(a).not.toContain('125,000');});
it('does not treat missing payslips as zero earnings',()=>{expect(renderPayrollFacts('how much unknown earned this month',pay)).toContain('does not establish zero');});

it('does not substitute a first-name match for an unrecognized full name on ticket earnings', () => {
  const answer = renderPayrollFacts('HT and LT earning by Kate Morris only?', pay);
  expect(answer).toContain('did not return a matching payslip for Kate Morris');
  expect(answer).not.toContain('Kate Melody');
  expect(answer).not.toContain('98,000');
});

it('asks for clarification if a ticket earnings query matches duplicate Payroll identities', () => {
  const duplicate = { ...pay.data.bill.people[1], employee_id: 'another-kate' };
  const data = { bill: { ...pay.data.bill, people: [...pay.data.bill.people, duplicate] } };
  expect(renderPayrollFacts('HT and LT earning by Kate Melody only?', { ...pay, data })).toContain('More than one record matches');
});

const namedSales={...performance,data:{...performance.data,sales:[{...performance.data.sales[0],owner:'Adrian Cole'},{...performance.data.sales[1],owner:'Kate Melody'}]}};
it.each(['what is the total closing of adrian in november','adrian closing total nov','tell me adrian total sales','Adrian closings please',"what is adrian’s sales total",'how much has adrian closed this month'])('resolves source first names across wording: %s',q=>{const a=renderPayrollFacts(q,namedSales);expect(a).toContain('Adrian Cole — 1 closings');expect(a).not.toContain('Client B');expect(a).not.toContain('Company-wide');});
it('does not widen a named unknown closing request to company data',()=>{expect(renderPayrollFacts('total closing of unknown in november',namedSales)).toContain('No company-wide total');});
