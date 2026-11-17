import { z } from 'zod';
import { localDateTime, zonedDayBoundsUTC, todayIn } from '@/lib/timezone';
import { readLivePayroll } from './payroll-live';

export type Window = {start:string;end:string};
export function reportingWindow(query:string,timeZone:string,now=new Date()): Window | null {
 query=query.replace(/\b(last|past)\s+(hour|minute)\b/gi,'$1 1 $2');
 const relative=query.match(/\b(?:last|past)\s+(?:(\d+(?:\.\d+)?)|(one|two|three))\s+(hours?|minutes?)\b/i);
 if(relative){const n=relative[1]?Number(relative[1]):({one:1,two:2,three:3} as Record<string,number>)[relative[2].toLowerCase()];const ms=n*(/^hour/i.test(relative[3])?3600000:60000);if(ms<=0||ms>7*86400000)throw Error('Choose a positive time window up to seven days.');return {start:new Date(+now-ms).toISOString(),end:now.toISOString()};}
 const explicit=query.match(/(?:from|between)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))\s+(?:to|and)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))/i);
 if(explicit){const a=Date.parse(explicit[1]),b=Date.parse(explicit[2]);if(!Number.isFinite(a)||!Number.isFinite(b)||a>=b||b-a>7*86400000)throw Error('Choose a valid increasing time window up to seven days.');return {start:new Date(a).toISOString(),end:new Date(b).toISOString()};}
 const clock=query.match(/\b(?:from|between)\s+(\d{1,2}):(\d{2})\s+(?:to|and)\s+(\d{1,2}):(\d{2})\b/i);
 if(clock){const date=query.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0]??(/\btoday\b/i.test(query)?todayIn(timeZone,now):null);if(!date)throw Error('Specify the date for this clock-time range.');const toInstant=(h:string,m:string)=>{if(+h>23||+m>59)throw Error('Invalid clock time.');const wanted=date+' '+h.padStart(2,'0')+':'+m;let t=Date.parse(zonedDayBoundsUTC(date,timeZone).startISO)+(+h*60+ +m)*60000;for(let i=0;i<3;i++){const actual=localDateTime(t,timeZone).slice(0,16);if(actual===wanted){if(localDateTime(t-3600000,timeZone)===wanted||localDateTime(t+3600000,timeZone)===wanted)throw Error('Ambiguous local time; specify an ISO timestamp with UTC offset.');return new Date(t).toISOString();}t+=Date.parse(wanted.replace(' ','T')+':00Z')-Date.parse(actual.replace(' ','T')+':00Z');}throw Error('That local time is ambiguous or unavailable; specify an ISO timestamp with UTC offset.');};const start=toInstant(clock[1],clock[2]),end=toInstant(clock[3],clock[4]);if(start>=end)throw Error('End time must follow start time.');return {start,end};}
 return null;
}
const safe=(v:unknown)=>String(v??'Not recorded').replace(/[|<>\r\n]/g,' ');
const tab=(h:string[],rs:unknown[][])=>'| '+h.join(' | ')+' |\n| '+h.map(()=> '---').join(' | ')+' |\n'+rs.map(r=>'| '+r.map(safe).join(' | ')+' |').join('\n');
async function countRows(table:string,column:string,w:Window,signal:AbortSignal,extra:Record<string,string>={}){
 const key=process.env.PAYROLL_REPORTS_SERVER_KEY;if(!key)throw Error('Payroll connection unavailable');
 const p=new URLSearchParams({select:'id',and:'('+column+'.gte.'+w.start+','+column+'.lt.'+w.end+')',...extra});
 const r=await fetch('https://zxifguiyvzrafrqskeyq.supabase.co/rest/v1/'+table+'?'+p,{method:'HEAD',headers:{apikey:key,...(key.startsWith('eyJ')?{Authorization:'Bearer '+key}:{}),Prefer:'count=exact'},cache:'no-store',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(8000)])});
 const count=r.headers.get('content-range')?.split('/')[1];if(!r.ok||!count||!/^\d+$/.test(count))throw Error('Exact source count unavailable');return Number(count);
}
export async function hourlyReport(query:string,w:Window,timeZone:string,email:string,signal:AbortSignal){
 if(/\b(fines?|bonuses?|payroll cost|salary|attendance)\b/i.test(query))return 'These records do not establish an hourly amount or attendance ruling. Ask for the Payroll month or attendance day; no prorated value has been invented.';
 const rows:unknown[][]=[];
 if(/\b(calls?|dials?|activity|missed)\b/i.test(query)){
 const [all,outbound,inbound,missed]=await Promise.all([countRows('ghl_calls','called_at',w,signal),countRows('ghl_calls','called_at',w,signal,{direction:'eq.outbound'}),countRows('ghl_calls','called_at',w,signal,{direction:'eq.inbound'}),countRows('ghl_calls','called_at',w,signal,{direction:'eq.inbound',status:'in.(no-answer,busy,failed,missed)'})]);
 rows.push(['Synced call records',all],['Outbound call records',outbound],['Inbound call records',inbound],['Inbound missed/no-answer/busy/failed',missed]);
 }
 if(/\b(appointments?|meetings?|show[ -]?ups?|no[ -]?shows?|activity)\b/i.test(query)){
 const [n,show,no]=await Promise.all([countRows('ghl_appointments','start_time',w,signal,{deleted_at:'is.null'}),countRows('ghl_appointments','start_time',w,signal,{deleted_at:'is.null',appt_status:'eq.showed'}),countRows('ghl_appointments','start_time',w,signal,{deleted_at:'is.null',appt_status:'eq.noshow'})]);rows.push(['CRM appointments scheduled in window',n],['Raw CRM showed status (not Payroll-reviewed)',show],['Raw CRM noshow status (not Payroll-reviewed)',no]);
 }
 let note='Synced CRM records in Payroll, not a live CRM refresh. Missing or delayed synchronization can make this incomplete; zero stored rows does not prove zero real activity.';
 if(/\b(sales|closed|closings?|ht|lt)\b/i.test(query)){
 const source=await readLivePayroll('closings',email,w.start.slice(0,10),w.end.slice(0,10),signal);
 const schema=z.object({origin:z.string(),closed_at:z.string(),usd_minor:z.number(),ticket:z.string()});const d=z.object({dated:z.array(schema),undated:z.array(schema)}).parse(source.data);
 const forms=d.dated.filter(r=>r.origin==='form'&&Date.parse(r.closed_at)>=Date.parse(w.start)&&Date.parse(r.closed_at)<Date.parse(w.end)&&(!/\bht\b|high[ -]ticket/i.test(query)||r.ticket==='high_ticket')&&(!/\blt\b|low[ -]ticket/i.test(query)||r.ticket==='low_ticket'));
 rows.push(['Recognized form sales submitted in window',forms.length],['Form sales submitted: USD', (forms.reduce((n,r)=>n+r.usd_minor,0)/100).toFixed(2)]);
 note+=' Form submission time is not the actual closing time. Admin entries have day/month precision and are excluded from hourly totals; '+[...d.dated,...d.undated].filter(r=>r.origin!=='form').length+' such entries exist in the touched Payroll scope. This is not a complete hourly closing total.';
 }
 if(!rows.length)return 'Specify calls, appointments or sales for the time window. No result was inferred.';
 return '**Timestamped activity — '+safe(localDateTime(w.start,timeZone))+' to '+safe(localDateTime(w.end,timeZone))+' · '+safe(timeZone)+'**\n\n'+tab(['Metric','Count/value'],rows)+'\n\nWindow is start-inclusive, end-exclusive: '+w.start+' to '+w.end+'.\n\n'+note+'\n\nSource: [Sales Payroll](https://payroll.practicescalingsystems.com/admin), checked '+new Date().toISOString()+'.';
}
const opp=z.object({id:z.string(),locationId:z.string(),status:z.string(),monetaryValue:z.number().nullable().optional(),contactId:z.string().nullable().optional(),contact:z.object({id:z.string()}).nullable().optional()});
export async function contactOpportunities(contactId:string,signal:AbortSignal){
 if(!/^[A-Za-z0-9_-]{1,100}$/.test(contactId))throw Error('No CRM contact ID');const location=process.env.BRAIN_GHL_LOCATION_ID,token=process.env.BRAIN_GHL_READ_TOKEN;if(!location||!token)throw Error('CRM unavailable');const all:z.infer<typeof opp>[]=[];
 for(let page=1;page<=10;page++){
 const q=new URLSearchParams({locationId:location,contactId,limit:'100',page:String(page),status:'all'});
 const r=await fetch('https://services.leadconnectorhq.com/opportunities/search?'+q,{headers:{Authorization:'Bearer '+token,Version:'v3'},cache:'no-store',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(6000)])});if(!r.ok)throw Error('CRM unavailable');const d=z.object({opportunities:z.array(opp)}).parse(await r.json());
 if(d.opportunities.some(o=>o.locationId!==location||(o.contactId??o.contact?.id)!==contactId))throw Error('CRM scope mismatch');
 all.push(...d.opportunities);if(d.opportunities.length<100)return all;
 }throw Error('Too many CRM records; no partial total');
}
export async function comparePayrollCrm(email:string,from:string,through:string,query:string,signal:AbortSignal){
 const source=await readLivePayroll('closings',email,from,through,signal);
 const sale=z.object({contact_id:z.string(),contact_name:z.string().nullable(),usd_minor:z.number(),ticket:z.string(),date_recorded:z.boolean(),closed_at:z.string()});const d=z.object({dated:z.array(sale),undated:z.array(sale)}).parse(source.data);
 const monthly=from.endsWith('-01')&&from.slice(0,7)===through.slice(0,7);
 const sales=[...d.dated,...(monthly?d.undated:[])].filter(r=>(!/\bht\b|high[ -]ticket/i.test(query)||r.ticket==='high_ticket')&&(!/\blt\b|low[ -]ticket/i.test(query)||r.ticket==='low_ticket'));
 const contacts=[...new Set(sales.map(s=>s.contact_id))];if(contacts.length>100)return 'This comparison exceeds 100 Payroll contacts. Narrow the dates; no partial comparison was presented.';
 const result=new Map<string,Awaited<ReturnType<typeof contactOpportunities>>|null>();let next=0;
 await Promise.all(Array.from({length:Math.min(6,contacts.length)},async()=>{while(next<contacts.length){const id=contacts[next++];try{result.set(id,await contactOpportunities(id,signal));}catch{signal.throwIfAborted();result.set(id,null);}}}));
 const rows=sales.map(s=>{const crm=result.get(s.contact_id);const missing=s.contact_id.startsWith('entry:');return [s.contact_name??s.contact_id,s.ticket,(s.usd_minor/100).toFixed(2),missing?'No linked CRM contact ID':crm===null?'Unavailable':crm?.length?crm.map(o=>o.id+': '+o.status+' / value '+(o.monetaryValue??'not recorded')).join('; '):'No matching opportunity',missing?'Cannot match without CRM ID':crm===null?'Not verified':!crm?.length?'No CRM match':crm.length!==1?'Multiple opportunities — attribution unresolved':crm[0].status!=='won'?'Payroll sale; CRM '+crm[0].status:'Payroll sale; CRM won'];});
 return '**Payroll vs live CRM — '+from+' to '+through+'**\n\nPayroll: '+sales.length+' recognized sales, USD '+(sales.reduce((n,r)=>n+r.usd_minor,0)/100).toFixed(2)+'.\n\n'+tab(['Payroll client','Ticket','Payroll USD','Live CRM opportunities/status/value','Comparison'],rows)+'\n\nMatched by CRM contact ID, not name. CRM values are displayed as recorded, without assuming currency or summing duplicate opportunities. Payroll recognizes forms/admin entries; CRM is current pipeline state, not proof of when a sale closed. Differences need review, not automatic correction. This reconciles the selected Payroll sales, not every CRM-only opportunity. '+(monthly?d.undated.length+' undated admin entries are assigned to the Payroll month.':'Undated admin entries excluded from daily scope.')+'\n\nSource: [Sales Payroll](https://payroll.practicescalingsystems.com/admin) and live GHL CRM. Checked '+new Date().toISOString()+'.';
}
