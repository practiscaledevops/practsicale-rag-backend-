import {timingSafeEqual} from 'node:crypto';
import {rollingAppointmentWindow,syncAppointmentSnapshot} from '@/lib/connectors/appointment-snapshot';
export const runtime='nodejs';export const preferredRegion=['sin1'];export const maxDuration=300;
export async function GET(req:Request){
 const secret=process.env.CRON_SECRET,a=Buffer.from(req.headers.get('authorization')??''),b=Buffer.from('Bearer '+secret);
 if(!secret||a.length!==b.length||!timingSafeEqual(a,b))return Response.json({error:'Unauthorized'},{status:401});
 try{const published=await syncAppointmentSnapshot(rollingAppointmentWindow(),AbortSignal.any([req.signal,AbortSignal.timeout(240000)]));return Response.json({published});}
 catch(error){console.error('[appointment-snapshot]',error instanceof Error?error.message:'Sync failed');return Response.json({error:'Complete sync failed; previous snapshot retained'},{status:503});}
}
