import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
export type TimeWindow={start:string;end:string};
let crmCooldownUntil=0;
async function request(path:string,signal:AbortSignal,body?:unknown,retried=false):Promise<unknown>{
 if(crmCooldownUntil>Date.now())await delay(crmCooldownUntil-Date.now(),undefined,{signal});
 const token=process.env.BRAIN_GHL_READ_TOKEN;if(!token)throw Error('Live CRM is not configured');
 const r=await fetch('https://services.leadconnectorhq.com'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,Version:path.startsWith('/calendars/')?'2021-07-28':'v3',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(path.startsWith('/calendars/')?15000:8000)])});
 if(r.status===429&&!retried){const raw=r.headers.get('retry-after');const seconds=raw===null?10:/^\d+(?:\.\d+)?$/.test(raw)?Number(raw):Math.max(0,(Date.parse(raw)-Date.now())/1000);if(Number.isFinite(seconds)&&seconds>=0&&seconds<=15){crmCooldownUntil=Math.max(crmCooldownUntil,Date.now()+Math.max(1000,seconds*1000));return request(path,signal,body,true);}}
 if(!r.ok)throw Error('Live CRM '+path.split('?')[0]+' unavailable ('+r.status+')');return r.json();
}
function location(){const id=process.env.BRAIN_GHL_LOCATION_ID;if(!id)throw Error('CRM location unavailable');return id;}
const opportunity=z.object({id:z.string(),locationId:z.string(),name:z.string().optional(),status:z.string(),assignedTo:z.string().nullable().optional(),contactId:z.string().nullable().optional(),contact:z.object({id:z.string(),name:z.string().optional()}).nullable().optional(),monetaryValue:z.number().nullable().optional(),lastStatusChangeAt:z.string().nullable().optional()});
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
export async function liveAppointmentRows(w:TimeWindow,signal:AbortSignal,progress?:(label:string)=>void){
 progress?.('Loading the live calendar directory');
 const loc=location();
 const catalog=z.object({calendars:z.array(z.object({id:z.string(),locationId:z.string(),groupId:z.string().nullable().optional()}))}).parse(await request('/calendars/?'+new URLSearchParams({locationId:loc,showDrafted:'true'}),signal));
 if(catalog.calendars.some(c=>c.locationId!==loc))throw Error('Calendar location mismatch');
 const ids=[...new Set(catalog.calendars.map(c=>c.id))];if(ids.length>150)throw Error('Calendar coverage exceeds live report limit');
 const scopes=new Map<string,{groupId?:string;calendarId?:string;ids:Set<string>}>();
 for(const cal of catalog.calendars){const key=cal.groupId?'group:'+cal.groupId:'calendar:'+cal.id;const scope=scopes.get(key)??{...(cal.groupId?{groupId:cal.groupId}:{calendarId:cal.id}),ids:new Set<string>()};scope.ids.add(cal.id);scopes.set(key,scope);}
 const jobs=[...scopes.values()],events=new Map<string,z.infer<typeof appointment>>();let next=0,nextStart=Date.now(),completed=0;
 progress?.(`Checking calendars: 0 of ${ids.length}`);
 const cancel=new AbortController(),readSignal=AbortSignal.any([signal,cancel.signal]);
 console.info('[live-appointments-coverage]',JSON.stringify({calendars:ids.length,requests:jobs.length}));
 try{await Promise.all(Array.from({length:Math.min(8,jobs.length)},async()=>{while(next<jobs.length){
 const scope=jobs[next++];const startAt=nextStart;nextStart=Math.max(Date.now(),nextStart)+150;
 await delay(Math.max(0,startAt-Date.now()),undefined,{signal:readSignal});
 const q=new URLSearchParams({locationId:loc,...(scope.groupId?{groupId:scope.groupId}:{calendarId:scope.calendarId!}),startTime:String(Date.parse(w.start)),endTime:String(Date.parse(w.end)-1)});
 const d=z.object({events:z.array(appointment)}).parse(await request('/calendars/events?'+q,readSignal));
 for(const e of d.events){if(e.locationId!==loc||!scope.ids.has(e.calendarId))throw Error('Appointment scope mismatch');if(e.deleted)continue;const t=Date.parse(e.startTime);if(!Number.isFinite(t))throw Error('Appointment timestamp missing');if(t<Date.parse(w.start)||t>=Date.parse(w.end))continue;const prior=events.get(e.id);if(prior&&JSON.stringify(prior)!==JSON.stringify(e))throw Error('Appointment changed during live report');events.set(e.id,e);}
 completed+=scope.ids.size;progress?.(`Checking calendars: ${completed} of ${ids.length}`);
 }}));}catch(error){cancel.abort();throw error;}
 if(events.size>50000)throw Error('Appointment snapshot exceeds safe row limit');
 return {rows:[...events.values()],calendars:ids.length};
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

export async function liveAppointmentCounts(w:TimeWindow,signal:AbortSignal,progress?:(label:string)=>void){
 const {rows,calendars}=await liveAppointmentRows(w,signal,progress);const count=(s:string)=>rows.filter(e=>e.appointmentStatus===s).length;
 return {total:rows.length,showed:count('showed'),noshow:count('noshow'),cancelled:count('cancelled')+count('canceled'),invalid:count('invalid'),calendars};
}

/** Location-scoped directory: only IDs/names are retained, never emails or phone numbers. */
export async function liveCrmUsers(signal:AbortSignal){
 const loc=location();
 const account=z.object({location:z.object({id:z.string(),companyId:z.string().min(1)})}).parse(await request('/locations/'+encodeURIComponent(loc),signal));
 if(account.location.id!==loc)throw Error('CRM location scope mismatch');
 const user=z.object({id:z.string().min(1),name:z.string().optional(),firstName:z.string().optional(),lastName:z.string().optional(),roles:z.object({locationIds:z.array(z.string())}).optional()});
 const all:{id:string;name:string}[]=[],seen=new Set<string>();let expected:number|undefined;
 for(let page=0;page<100;page++){
  const q=new URLSearchParams({locationId:loc,companyId:account.location.companyId,skip:String(all.length),limit:'100'});
  const result=z.object({users:z.array(user),count:z.number().int().nonnegative()}).parse(await request('/users/search?'+q,signal));
  if(expected!==undefined&&result.count!==expected)throw Error('CRM directory changed during pagination');expected=result.count;
  for(const u of result.users){if((u.roles&&!u.roles.locationIds.includes(loc))||seen.has(u.id))throw Error('CRM user scope or pagination mismatch');seen.add(u.id);all.push({id:u.id,name:(u.name??[u.firstName,u.lastName].filter(Boolean).join(' ')).trim()});}
  if(all.length===expected)return all;
  if(!result.users.length||all.length>expected)throw Error('Incomplete CRM user directory');
 }
 throw Error('CRM user directory exceeds safe limit');
}
