import {z} from 'zod';
export type TimeWindow={start:string;end:string};
async function request(path:string,signal:AbortSignal,body?:unknown){
 const token=process.env.BRAIN_GHL_READ_TOKEN;if(!token)throw Error('Live CRM is not configured');
 const r=await fetch('https://services.leadconnectorhq.com'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,Version:path.startsWith('/calendars/')?'2021-07-28':'v3',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(8000)])});
 if(!r.ok)throw Error('Live CRM '+path.split('?')[0]+' unavailable ('+r.status+')');return r.json();
}
function location(){const id=process.env.BRAIN_GHL_LOCATION_ID;if(!id)throw Error('CRM location unavailable');return id;}
const opportunity=z.object({id:z.string(),locationId:z.string(),name:z.string().optional(),status:z.string(),contactId:z.string().nullable().optional(),contact:z.object({id:z.string(),name:z.string().optional()}).nullable().optional(),monetaryValue:z.number().nullable().optional(),lastStatusChangeAt:z.string().nullable().optional()});
// Read-only search; no CRM business records are changed.
export async function liveWonOpportunities(signal:AbortSignal,w?:TimeWindow){
 const loc=location(),all:z.infer<typeof opportunity>[]=[],seen=new Set<string>();
 for(let page=1;page<=20;page++){
  const d=z.object({opportunities:z.array(opportunity)}).parse(await request('/opportunities/search',signal,{locationId:loc,limit:500,page,filters:[{field:'status',operator:'eq',value:'won'},...(w?[{group:'OR',filters:[{field:'last_status_change_date',operator:'range',value:{gte:w.start,lte:new Date(Date.parse(w.end)-1).toISOString()}},{field:'last_status_change_date',operator:'not_exists'}]}]:[])]}));
  for(const o of d.opportunities){if(o.locationId!==loc||o.status!=='won'||seen.has(o.id))throw Error('CRM returned inconsistent scope or pagination');seen.add(o.id);all.push(o);}
  if(d.opportunities.length<500)return all;
 }throw Error('CRM scan exceeded its safe limit; comparison is incomplete');
}
const call=z.object({id:z.string(),locationId:z.string(),dateAdded:z.string(),direction:z.enum(['inbound','outbound']),messageType:z.string(),status:z.string().optional(),meta:z.object({callStatus:z.string().optional(),call:z.object({status:z.string().optional()}).optional()}).optional()});
export async function liveCallCounts(w:TimeWindow,signal:AbortSignal){
 const loc=location(),seen=new Set<string>(),cursors=new Set<string>();let cursor:string|undefined;let total=0,outbound=0,inbound=0,missed=0;
 for(let page=0;page<30;page++){
  const q=new URLSearchParams({locationId:loc,channel:'Call',limit:'1000',sortBy:'createdAt',sortOrder:'asc',startDate:w.start,endDate:w.end,...(cursor?{cursor}:{})});
  const d=z.object({messages:z.array(call),nextCursor:z.string().nullable().optional(),total:z.number()}).parse(await request('/conversations/messages/export?'+q,signal));
  for(const m of d.messages){if(m.locationId!==loc||!['TYPE_CALL','TYPE_CAMPAIGN_CALL'].includes(m.messageType))throw Error('CRM returned unexpected call scope');if(seen.has(m.id))throw Error('CRM pagination repeated calls');seen.add(m.id);const t=Date.parse(m.dateAdded);if(!Number.isFinite(t))throw Error('CRM call timestamp unavailable');if(t<Date.parse(w.start)||t>=Date.parse(w.end))continue;total++;if(m.direction==='outbound')outbound++;else {inbound++;if(['no-answer','busy','failed','missed'].includes(m.meta?.call?.status??m.meta?.callStatus??m.status??''))missed++;}}
  if(!d.nextCursor){if(seen.size!==d.total)throw Error('CRM export count changed or pagination incomplete');return {total,outbound,inbound,missed};}
  if(cursors.has(d.nextCursor))throw Error('CRM cursor repeated');cursors.add(d.nextCursor);cursor=d.nextCursor;
 }throw Error('Live call window is too large; narrow the time range');
}

const appointment=z.object({id:z.string(),calendarId:z.string(),locationId:z.string(),startTime:z.string(),appointmentStatus:z.string(),deleted:z.boolean().optional()});
export async function liveAppointmentCounts(w:TimeWindow,signal:AbortSignal){
 const loc=location();
 const catalog=z.object({calendars:z.array(z.object({id:z.string(),locationId:z.string()}))}).parse(await request('/calendars/?'+new URLSearchParams({locationId:loc,showDrafted:'true'}),signal));
 if(catalog.calendars.some(c=>c.locationId!==loc))throw Error('Calendar location mismatch');
 const ids=[...new Set(catalog.calendars.map(c=>c.id))];if(ids.length>150)throw Error('Calendar coverage exceeds live report limit');
 const events=new Map<string,z.infer<typeof appointment>>();let next=0;
 await Promise.all(Array.from({length:Math.min(8,ids.length)},async()=>{while(next<ids.length){
 const calendarId=ids[next++];
 const q=new URLSearchParams({locationId:loc,calendarId,startTime:String(Date.parse(w.start)),endTime:String(Date.parse(w.end)-1)});
 const d=z.object({events:z.array(appointment)}).parse(await request('/calendars/events?'+q,signal));
 for(const e of d.events){if(e.locationId!==loc||e.calendarId!==calendarId)throw Error('Appointment scope mismatch');if(e.deleted)continue;const t=Date.parse(e.startTime);if(!Number.isFinite(t))throw Error('Appointment timestamp missing');if(t<Date.parse(w.start)||t>=Date.parse(w.end))continue;const prior=events.get(e.id);if(prior&&JSON.stringify(prior)!==JSON.stringify(e))throw Error('Appointment changed during live report');events.set(e.id,e);}
 }}));
 const rows=[...events.values()];const count=(s:string)=>rows.filter(e=>e.appointmentStatus===s).length;
 return {total:rows.length,showed:count('showed'),noshow:count('noshow'),cancelled:count('cancelled')+count('canceled'),invalid:count('invalid'),calendars:ids.length};
}

export async function liveContactOpportunities(ids:string[],signal:AbortSignal){
 const loc=location(),contacts=[...new Set(ids)];if(!contacts.length)return [];
 if(contacts.length>100||contacts.some(id=>!/^[A-Za-z0-9_-]{1,100}$/.test(id)))throw Error('Invalid contact scope');
 const allowed=new Set(contacts),seen=new Set<string>(),all:z.infer<typeof opportunity>[]=[];
 for(let page=1;page<=20;page++){
 const d=z.object({opportunities:z.array(opportunity)}).parse(await request('/opportunities/search',signal,{locationId:loc,limit:500,page,filters:[{group:'OR',filters:contacts.map(value=>({field:'contact_id',operator:'eq',value}))}]}));
 for(const o of d.opportunities){if(o.locationId!==loc||!allowed.has(o.contactId??o.contact?.id??'')||seen.has(o.id))throw Error('CRM contact scope or pagination mismatch');seen.add(o.id);all.push(o);}
 if(d.opportunities.length<500)return all;
 }throw Error('Contact comparison exceeded safe limit');
}
