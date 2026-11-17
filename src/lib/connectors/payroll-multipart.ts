import {z} from 'zod';
import {readLivePayroll} from './payroll-live';
const safe=(v:unknown)=>String(v??'Not recorded').replace(/[|<>\r\n]/g,' ');
const table=(h:string[],r:unknown[][])=>'| '+h.join(' | ')+' |\n| '+h.map(()=> '---').join(' | ')+' |\n'+r.map(x=>'| '+x.map(safe).join(' | ')+' |').join('\n');
export function multipartNeeds(query:string){
 const setters=/\bsetters?\b/i.test(query)&&/\b(top|best|rank|ranking|leaders?)\b/i.test(query);
 const high=/\b(ht|high[ -]ticket)\b/i.test(query),low=/\b(lt|low[ -]ticket)\b/i.test(query);
 const consultant=/\bconsultants?\b/i.test(query)&&/\b(top|best|highest|earner|earning|earners)\b/i.test(query);
 const earnings=consultant&&/\b(earners?|earnings?|paid|salary|pay)\b/i.test(query);
 return {setters,high,low,consultant,earnings,handled:[setters,high,low,consultant].filter(Boolean).length>=2||setters||earnings};
}
type Source={data?:unknown;fetched_at:string};
export function renderMultipart(query:string,from:string,through:string,sources:Partial<Record<'performance'|'people'|'teams'|'payroll',Source>>){
 const needs=multipartNeeds(query);const blocks:string[]=[];const money=(v:number)=>(v/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
 const group=z.object({key:z.string(),label:z.string(),booked:z.number(),showed:z.number(),closings:z.number(),usd_minor:z.number()});
 const perf=z.object({setters:z.array(group),consultants:z.array(group),sales:z.array(z.object({ticket:z.enum(['high_ticket','low_ticket']),usd_minor:z.number()})),undated_entries:z.number(),summary:z.object({absent_shows:z.string().nullable()})}).safeParse(sources.performance?.data);
 const people=z.object({people:z.array(z.object({id:z.string(),name:z.string().nullable(),role:z.string().nullable(),status:z.string()}))}).safeParse(sources.people?.data);
 const teams=z.object({teams:z.array(z.object({name:z.string(),leader:z.object({name:z.string()}).nullable(),members:z.array(z.object({employeeId:z.string()}))}))}).safeParse(sources.teams?.data);
 if(needs.setters){
 const n=Math.min(100,Math.max(1,Number(query.match(/\btop\s+(\d+)\b/i)?.[1]??10)));
 blocks.push('### Top '+n+' setters and their leaders');
 if(!perf.success||!people.success||perf.data.summary.absent_shows)blocks.push('The setter ranking could not be verified from the current authorized source reports. Other sections below are independent.');
 else{
 const eligible=new Set(people.data.people.filter(p=>p.role==='setter'&&p.status==='active').map(p=>p.id));
 const rows=perf.data.setters.filter(s=>eligible.has(s.key)).sort((a,b)=>b.showed-a.showed||b.booked-a.booked||a.label.localeCompare(b.label)).slice(0,n);
 blocks.push('Ranking basis: reviewed show-ups for the requested period; ties use booked contacts, then name. Only current active Payroll setters are included. This is not an earnings or overall-quality ranking.');
 blocks.push(table(['Rank','Setter','Current leader','Current team','Show-ups','Booked contacts','Attributed closings'],rows.map((r,i)=>{const ts=teams.success?teams.data.teams.filter(t=>t.members.some(m=>m.employeeId===r.key)):[];return[i+1,r.label,!teams.success?'Unavailable':ts.length?ts.map(t=>t.leader?.name??'Not assigned').join('; '):'Not assigned',!teams.success?'Unavailable':ts.length?ts.map(t=>t.name).join('; '):'Not assigned',r.showed,r.booked,r.closings];})));
 blocks.push('Leaders and teams are current assignments, not a claim about historical membership.');
 }
 }
 if(needs.high||needs.low){blocks.push('### '+(needs.high&&needs.low?'HT and LT closing totals':needs.high?'HT closing total':'LT closing total'));
 if(!perf.success)blocks.push('Closing totals could not be verified; unavailable data is not zero.');else{
 const kinds=[...(needs.high?['high_ticket']:[]),...(needs.low?['low_ticket']:[])];
 const rows=kinds.map(k=>{const sales=perf.data.sales.filter(s=>s.ticket===k);return[k==='high_ticket'?'High ticket (HT)':'Low ticket (LT)',sales.length,money(sales.reduce((n,s)=>n+s.usd_minor,0))];});
 if(needs.high&&needs.low)rows.push(['Combined',perf.data.sales.length,money(perf.data.sales.reduce((n,s)=>n+s.usd_minor,0))]);
 blocks.push(table(['Category','Closings','Closed value (USD)'],rows));blocks.push(perf.data.undated_entries+' admin entries lack exact closing dates; month-assigned entries are not precise daily/hourly closings. Deal counts are not necessarily unique client counts.');
 }}
 if(needs.consultant){blocks.push('### '+(needs.earnings?'Top-earning consultant':'Top consultant by closed revenue'));
 if(needs.earnings){
 const pay=z.object({bill:z.object({people:z.array(z.object({employee_id:z.string(),name:z.string(),role:z.string(),minor:z.number()})),run_status:z.string(),last_recalculated_at:z.string().nullable(),composition_reconciles:z.boolean()})}).safeParse(sources.payroll?.data);
 if(!pay.success)blocks.push('Consultant earnings could not be verified from the authorized Payroll run. Sales revenue is not personal earnings, so no revenue winner is substituted.');
 else {const rows=pay.data.bill.people.filter(p=>p.role==='consultant').sort((a,b)=>b.minor-a.minor);const top=rows.filter(p=>p.minor===rows[0]?.minor);blocks.push(top.length?table(['Consultant','Payroll earnings (PKR)'],top.map(p=>[p.name,money(p.minor)])):'No consultant payslips are recorded in this run.');blocks.push('These are whole-month calculated payslip totals, not cash-payment confirmation or a daily prorated amount. Run status: '+safe(pay.data.bill.run_status)+'. Last recalculated: '+safe(pay.data.bill.last_recalculated_at)+'.');if(!pay.data.bill.composition_reconciles)blocks.push('Payroll flags a mismatch between its bill composition and total. This ranking reflects recorded payslips and is not a fully reconciled payout confirmation.');}
 }else if(perf.success&&people.success){const ids=new Set(people.data.people.filter(p=>p.role==='consultant').map(p=>p.id));const rows=perf.data.consultants.filter(p=>ids.has(p.key)).sort((a,b)=>b.usd_minor-a.usd_minor);blocks.push(table(['Consultant','Closed value (USD)','Closings'],rows.filter(p=>p.usd_minor===rows[0]?.usd_minor).map(p=>[p.label,money(p.usd_minor),p.closings])));blocks.push('Ranked by closed sales value, not salary, commission or coaching quality.');}else blocks.push('The consultant revenue ranking could not be verified.');
 }
 return '**Payroll report — '+from+' to '+through+'**\n\n'+blocks.join('\n\n')+'\n\nSource: [Sales Payroll](https://payroll.practicescalingsystems.com/admin). Each section uses its own current authorized report. Checked '+(Object.values(sources).map(s=>s?.fetched_at).filter(Boolean).sort().at(-1)??'unavailable')+'.';
}
export async function readMultipart(query:string,from:string,through:string,email:string,signal:AbortSignal){
 const needs=multipartNeeds(query);const reports:('performance'|'people'|'teams'|'payroll')[]=['performance'];
 if(needs.setters||needs.consultant)reports.push('people');if(needs.setters)reports.push('teams');if(needs.earnings)reports.push('payroll');
 const sources:Partial<Record<typeof reports[number],Source>>={};
 await Promise.all(reports.map(async r=>{try{sources[r]=await readLivePayroll(r,email,from,through,signal);}catch{signal.throwIfAborted();}}));
 return renderMultipart(query,from,through,sources);
}
