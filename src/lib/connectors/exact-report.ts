import {liveCallCounts,liveWonOpportunities,liveAppointmentCounts,liveContactOpportunities} from './live-crm';
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
export async function hourlyReport(query:string,w:Window,timeZone:string,email:string,signal:AbortSignal,progress?:(label:string)=>void){
 if(/\b(fines?|bonuses?|payroll cost|salary|attendance)\b/i.test(query))return 'These records do not establish an hourly amount or attendance ruling. Ask for the Payroll month or attendance day; no prorated value has been invented.';
 const rows:unknown[][]=[];
 const wantCalls=/\b(calls?|dials?|activity|missed)\b/i.test(query),wantAppointments=/\b(appointments?|meetings?|show[ -]?ups?|no[ -]?shows?|activity)\b/i.test(query);
 const [callData,appointmentData]=await Promise.all([wantCalls?liveCallCounts(w,signal):null,wantAppointments?liveAppointmentCounts(w,signal,progress):null]);
 if(callData){
 const counts=callData;
 rows.push(['Live CRM call records',counts.total],['Outbound call records',counts.outbound],['Inbound call records',counts.inbound],['Inbound missed/no-answer/busy/failed',counts.missed]);
 }
 if(appointmentData){
 rows.push(['Live CRM appointments starting in window',appointmentData.total],['CRM showed status (not Payroll-reviewed)',appointmentData.showed],['CRM noshow status (not Payroll-reviewed)',appointmentData.noshow],['CRM cancelled appointments',appointmentData.cancelled],['CRM invalid appointments',appointmentData.invalid],['Calendars checked',appointmentData.calendars]);
 }
 let note='Calls and appointments are read directly from GHL. Call windows use message creation timestamps; appointment windows use scheduled start timestamps. Deleted appointments are excluded; cancelled and invalid appointments are included and identified separately. Raw CRM attendance statuses are not Payroll-reviewed show-up rulings. GHL processing delays may still apply.';
 if(/\b(sales|closed|closings?|ht|lt)\b/i.test(query)){
 const source=await readLivePayroll('closings',email,w.start.slice(0,10),w.end.slice(0,10),signal);
 const schema=z.object({origin:z.string(),closed_at:z.string(),usd_minor:z.number(),ticket:z.string()});const d=z.object({dated:z.array(schema),undated:z.array(schema)}).parse(source.data);
 const forms=d.dated.filter(r=>r.origin==='form'&&Date.parse(r.closed_at)>=Date.parse(w.start)&&Date.parse(r.closed_at)<Date.parse(w.end)&&(!/\bht\b|high[ -]ticket/i.test(query)||r.ticket==='high_ticket')&&(!/\blt\b|low[ -]ticket/i.test(query)||r.ticket==='low_ticket'));
 rows.push(['Recognized form sales submitted in window',forms.length],['Form sales submitted: USD', (forms.reduce((n,r)=>n+r.usd_minor,0)/100).toFixed(2)]);
 note+=' Form submission time is not the actual closing time. Admin entries have day/month precision and are excluded from hourly totals; '+[...d.dated,...d.undated].filter(r=>r.origin!=='form').length+' such entries exist in the touched Payroll scope. This is not a complete hourly closing total.';
 }
 if(!rows.length)return 'Specify calls, appointments or sales for the time window. No result was inferred.';
 return '**Timestamped activity — '+safe(localDateTime(w.start,timeZone))+' to '+safe(localDateTime(w.end,timeZone))+' · '+safe(timeZone)+'**\n\n'+tab(['Metric','Count/value'],rows)+'\n\nWindow is start-inclusive, end-exclusive: '+w.start+' to '+w.end+'.\n\n'+note+'\n\nSource: live GHL for calls and appointments; [Sales Payroll](https://payroll.practicescalingsystems.com/admin) for any form sales. Checked '+new Date().toISOString()+'.';
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
 const reverseTask=liveWonOpportunities(signal,{start:from+'T00:00:00Z',end:new Date(Date.parse(through+'T00:00:00Z')+86400000).toISOString()}).then(rows=>({rows,error:false})).catch(()=>({rows:[],error:true}));
 const sale=z.object({contact_id:z.string(),contact_name:z.string().nullable(),usd_minor:z.number(),ticket:z.string(),date_recorded:z.boolean(),closed_at:z.string()});const d=z.object({dated:z.array(sale),undated:z.array(sale)}).parse(source.data);
 const monthly=from.endsWith('-01')&&from.slice(0,7)===through.slice(0,7);
 const allSales=[...d.dated,...(monthly?d.undated:[])];
 const bothTickets=/\bht\b|high[ -]ticket/i.test(query)&&/\blt\b|low[ -]ticket/i.test(query);
 const sales=allSales.filter(r=>(bothTickets||!/\bht\b|high[ -]ticket/i.test(query)||r.ticket==='high_ticket')&&(bothTickets||!/\blt\b|low[ -]ticket/i.test(query)||r.ticket==='low_ticket'));
 const contacts=[...new Set(sales.map(s=>s.contact_id))];if(contacts.length>100)return 'This comparison exceeds 100 Payroll contacts. Narrow the dates; no partial comparison was presented.';
 const result=new Map<string,Awaited<ReturnType<typeof contactOpportunities>>|null>();
 const validContacts=contacts.filter(id=>!id.startsWith('entry:'));
 try{const matches=await liveContactOpportunities(validContacts,signal);for(const id of validContacts)result.set(id,matches.filter(o=>(o.contactId??o.contact?.id)===id));}catch{signal.throwIfAborted();for(const id of validContacts)result.set(id,null);}
 const rows=sales.map(s=>{const crm=result.get(s.contact_id);const missing=s.contact_id.startsWith('entry:');return [s.contact_name??s.contact_id,s.ticket,(s.usd_minor/100).toFixed(2),s.date_recorded?s.closed_at:'Missing exact date — month only',missing?'No linked CRM contact ID':crm===null?'Unavailable':crm?.length?crm.map(o=>o.id+': '+o.status+' / value '+(o.monetaryValue??'not recorded')).join('; '):'No matching opportunity',missing?'Cannot match without CRM ID':crm===null?'Not verified':!crm?.length?'No CRM match':crm.length!==1?'Multiple opportunities — attribution unresolved':crm[0].status!=='won'?'Payroll sale; CRM '+crm[0].status:'Payroll sale; CRM won'];});
 const reverse=await reverseTask;
 const start=Date.parse(from+'T00:00:00Z'),end=Date.parse(through+'T00:00:00Z')+86400000;
 const payrollIds=new Set(allSales.map(s=>s.contact_id));
 const candidates=reverse.rows.filter(o=>{const t=Date.parse(o.lastStatusChangeAt??'');return !Number.isFinite(t)||(t>=start&&t<end);});
 const unmatched=candidates.filter(o=>!payrollIds.has(o.contactId??o.contact?.id??''));
 const reverseText=reverse.error?'Reverse CRM scan unavailable. The Payroll-to-CRM rows below remain independently checked; this is not a complete reconciliation.':
 'Reverse scan: '+reverse.rows.length+' current won CRM opportunities returned across all pipelines for this status-change date range or with no status-change date. '+unmatched.length+' have no contact-ID match in the full Payroll period roster (including both ticket categories).\n\n'+
 (unmatched.length?tab(['CRM opportunity','Contact','Recorded value','Last status change','Review'],unmatched.map(o=>[o.id,o.contactId??o.contact?.id??'No contact ID',o.monetaryValue??'Not recorded',o.lastStatusChangeAt??'Not recorded',!Number.isFinite(Date.parse(o.lastStatusChangeAt??''))?'Date unknown; period unverified':'No Payroll-period contact match'])):'No unmatched candidates found under this definition.')+
 '\n\nCRM date basis: current won state and last status-change timestamp, UTC dates. Undated won opportunities are included as unresolved candidates. This is not a complete historical win-event ledger: reopened/lost deals are outside this scan. A shared contact ID does not prove the individual deal matches. CRM ticket classification is not inferred from price; reverse candidates include all tickets.';
 return '**Payroll vs live CRM — '+from+' to '+through+'**\n\nPayroll: '+sales.length+' recognized sales, USD '+(sales.reduce((n,r)=>n+r.usd_minor,0)/100).toFixed(2)+'.\n\n'+tab(['Payroll client','Ticket','Payroll USD','Payroll recorded date','Live CRM opportunities/status/value','Comparison'],rows)+'\n\nMatched by CRM contact ID, not name. CRM values are displayed as recorded, without assuming currency or summing duplicate opportunities. Payroll recognizes forms/admin entries; CRM is current pipeline state, not proof of when a sale closed. Differences need review, not automatic correction. '+reverseText+' '+(monthly?d.undated.length+' undated admin entries are assigned to the Payroll month.':'Undated admin entries excluded from daily scope.')+'\n\nSource: [Sales Payroll](https://payroll.practicescalingsystems.com/admin) and live GHL CRM. Checked '+new Date().toISOString()+'.';
}
