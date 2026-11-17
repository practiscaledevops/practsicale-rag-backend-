import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {supabaseAdmin} from '@/lib/supabase';
import {liveAppointmentRows,type TimeWindow} from './live-crm';
export function rollingAppointmentWindow(now=new Date()):TimeWindow{return {start:new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,1)).toISOString(),end:new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1)).toISOString()};}
function loc(){const id=process.env.BRAIN_GHL_LOCATION_ID;if(!id)throw Error('CRM unavailable');return id;}
export async function syncAppointmentSnapshot(w:TimeWindow,signal:AbortSignal,progress?:(label:string)=>void){
 const db=supabaseAdmin(),location=loc(),owner=randomUUID(),key=location+':'+w.start+':'+w.end;
 const claim=await db.rpc('claim_appointment_snapshot',{k:key,loc:location,owner}).abortSignal(signal);
 if(claim.error)throw Error('Snapshot coordinator unavailable');if(!claim.data)return false;
 const started=new Date().toISOString();
 try{
  const data=await liveAppointmentRows(w,signal,progress);
  const saved=await db.rpc('publish_appointment_snapshot',{k:key,owner,ws:w.start,we:w.end,started,rows_json:data.rows,calendar_count:data.calendars}).abortSignal(signal);
  if(saved.error||saved.data!==true)throw Error('Complete snapshot could not be published');return true;
 }catch(error){
  await db.from('appointment_report_snapshots').update({last_failure_at:new Date().toISOString(),lease_id:null,lease_until:null}).eq('scope_key',key).eq('lease_id',owner).abortSignal(AbortSignal.timeout(5000));throw error;
 }
}
const counts=z.object({total:z.number().int().nonnegative(),showed:z.number(),noshow:z.number(),cancelled:z.number(),invalid:z.number(),calendars:z.number(),verifiedAt:z.string(),scanStartedAt:z.string(),lastFailureAt:z.string().nullable()});
export async function appointmentSnapshotCounts(w:TimeWindow,signal:AbortSignal,refresh=false,progress?:(label:string)=>void){
 if(refresh){const rolling=rollingAppointmentWindow();const scope=rolling.start<=w.start&&rolling.end>=w.end?rolling:w;
  if(!await syncAppointmentSnapshot(scope,signal,progress))throw Error('A snapshot refresh is already running. Try again shortly.');
 }
 progress?.('Reading the latest complete appointment snapshot');
 const result=await supabaseAdmin().rpc('read_appointment_snapshot',{loc:loc(),ws:w.start,we:w.end}).abortSignal(signal);
 if(result.error)throw Error('Appointment snapshot unavailable');if(!result.data)throw Error('No complete appointment snapshot covers this period. Choose Refresh from GHL.');
 return counts.parse(result.data);
}
