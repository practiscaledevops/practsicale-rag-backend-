import {z} from 'zod';
export type TimeWindow={start:string;end:string};
async function request(path:string,signal:AbortSignal,body?:unknown){
 const token=process.env.BRAIN_GHL_READ_TOKEN;if(!token)throw Error('Live CRM is not configured');
 const r=await fetch('https://services.leadconnectorhq.com'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,Version:'v3',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(8000)])});
 if(!r.ok)throw Error('Live CRM request unavailable ('+r.status+')');return r.json();
}
function location(){const id=process.env.BRAIN_GHL_LOCATION_ID;if(!id)throw Error('CRM location unavailable');return id;}
const opportunity=z.object({id:z.string(),locationId:z.string(),name:z.string().optional(),status:z.string(),contactId:z.string().nullable().optional(),contact:z.object({id:z.string(),name:z.string().optional()}).nullable().optional(),monetaryValue:z.number().nullable().optional(),lastStatusChangeAt:z.string().nullable().optional()});
// Read-only search; no CRM business records are changed.
export async function liveWonOpportunities(signal:AbortSignal){
 const loc=location(),all:z.infer<typeof opportunity>[]=[],seen=new Set<string>();
 for(let page=1;page<=20;page++){
  const d=z.object({opportunities:z.array(opportunity)}).parse(await request('/opportunities/search',signal,{locationId:loc,limit:500,page,filters:[{field:'status',operator:'eq',value:'won'}]}));
  for(const o of d.opportunities){if(o.locationId!==loc||o.status!=='won'||seen.has(o.id))throw Error('CRM returned inconsistent scope or pagination');seen.add(o.id);all.push(o);}
  if(d.opportunities.length<500)return all;
 }throw Error('CRM scan exceeded its safe limit; comparison is incomplete');
}
const call=z.object({id:z.string(),locationId:z.string(),dateAdded:z.string(),direction:z.enum(['inbound','outbound']),messageType:z.string(),meta:z.object({callStatus:z.string().optional()}).optional()});
export async function liveCallCounts(w:TimeWindow,signal:AbortSignal){
 const loc=location(),seen=new Set<string>(),cursors=new Set<string>();let cursor:string|undefined;let total=0,outbound=0,inbound=0,missed=0;
 for(let page=0;page<30;page++){
  const q=new URLSearchParams({locationId:loc,channel:'Call',limit:'1000',sortBy:'createdAt',sortOrder:'asc',startDate:w.start,endDate:w.end,...(cursor?{cursor}:{})});
  const d=z.object({messages:z.array(call),nextCursor:z.string().nullable().optional(),total:z.number()}).parse(await request('/conversations/messages/export?'+q,signal));
  for(const m of d.messages){if(m.locationId!==loc||!['TYPE_CALL','TYPE_CAMPAIGN_CALL'].includes(m.messageType))throw Error('CRM returned unexpected call scope');if(seen.has(m.id))throw Error('CRM pagination repeated calls');seen.add(m.id);const t=Date.parse(m.dateAdded);if(!Number.isFinite(t))throw Error('CRM call timestamp unavailable');if(t<Date.parse(w.start)||t>=Date.parse(w.end))continue;total++;if(m.direction==='outbound')outbound++;else {inbound++;if(['no-answer','busy','failed','missed'].includes(m.meta?.callStatus??''))missed++;}}
  if(!d.nextCursor){if(seen.size!==d.total)throw Error('CRM export count changed or pagination incomplete');return {total,outbound,inbound,missed};}
  if(cursors.has(d.nextCursor))throw Error('CRM cursor repeated');cursors.add(d.nextCursor);cursor=d.nextCursor;
 }throw Error('Live call window is too large; narrow the time range');
}
