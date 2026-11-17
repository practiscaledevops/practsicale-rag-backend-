import {it,expect,vi,afterEach,beforeEach} from 'vitest';
import {liveCallCounts,liveWonOpportunities,liveAppointmentCounts,liveContactOpportunities} from '@/lib/connectors/live-crm';
const signal=new AbortController().signal,w={start:'2026-11-17T09:00:00Z',end:'2026-11-17T10:00:00Z'};
beforeEach(()=>{vi.stubEnv('BRAIN_GHL_LOCATION_ID','loc');vi.stubEnv('BRAIN_GHL_READ_TOKEN','fixture');});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
const msg=(id:string,time=w.start,direction='inbound',status='no-answer')=>({id,dateAdded:time,direction,locationId:'loc',messageType:'TYPE_CALL',meta:{callStatus:status}});
it('counts all pages and excludes the end boundary',async()=>{const f=vi.fn().mockResolvedValueOnce(Response.json({messages:[msg('a')],total:3,nextCursor:'next'})).mockResolvedValueOnce(Response.json({messages:[msg('b',w.end),msg('c',w.start,'outbound','completed')],total:3,nextCursor:null}));vi.stubGlobal('fetch',f);expect(await liveCallCounts(w,signal)).toEqual({total:2,inbound:1,outbound:1,missed:1});expect(f.mock.calls[1][0]).toContain('cursor=next');expect(f.mock.calls[0][1].method).toBe('GET');});
it.each(['wrong-location','missing-page','bad-date','repeated-id'])('rejects incomplete or inconsistent calls: %s',async mode=>{const m=msg('a');if(mode==='wrong-location')m.locationId='other';if(mode==='bad-date')m.dateAdded='invalid';vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({messages:mode==='repeated-id'?[m,m]:[m],total:mode==='missing-page'?2:1,nextCursor:null})));await expect(liveCallCounts(w,signal)).rejects.toThrow();});
it('refuses CRM outages rather than returning zero',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(null,{status:403})));await expect(liveCallCounts(w,signal)).rejects.toThrow('403');});
it('scans won opportunities without restricting to Payroll contacts',async()=>{const f=vi.fn().mockResolvedValue(Response.json({opportunities:[{id:'crm-only',locationId:'loc',status:'won',contactId:'new-contact',lastStatusChangeAt:w.start}]}));vi.stubGlobal('fetch',f);expect(await liveWonOpportunities(signal)).toHaveLength(1);const body=JSON.parse(f.mock.calls[0][1].body);expect(body.filters).toEqual([{field:'status',operator:'eq',value:'won'}]);});
it('does not accept out-of-location opportunities',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({opportunities:[{id:'a',locationId:'other',status:'won'}]})));await expect(liveWonOpportunities(signal)).rejects.toThrow();});

it('uses the nested call outcome ahead of generic message delivery status',async()=>{const m={...msg('a'),status:'voicemail',meta:{call:{status:'no-answer'}}};vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({messages:[m],total:1,nextCursor:null})));expect((await liveCallCounts(w,signal)).missed).toBe(1);});

it('filters whole-day appointment responses by exact start and excludes deletions',async()=>{
 const base={calendarId:'c',locationId:'loc',appointmentStatus:'showed',startTime:w.start};const f=vi.fn().mockResolvedValueOnce(Response.json({calendars:[{id:'c',locationId:'loc'}]})).mockResolvedValueOnce(Response.json({events:[{...base,id:'start'},{...base,id:'end',startTime:w.end},{...base,id:'deleted',deleted:true},{...base,id:'cancelled',appointmentStatus:'cancelled'}]}));vi.stubGlobal('fetch',f);expect(await liveAppointmentCounts(w,signal)).toEqual({total:2,showed:1,noshow:0,cancelled:1,invalid:0,calendars:1});expect(f.mock.calls[1][0]).toContain('calendarId=c');
});
it('does not turn one unavailable calendar into a complete zero count',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(Response.json({calendars:[{id:'c',locationId:'loc'}]})).mockResolvedValue(new Response(null,{status:503})));await expect(liveAppointmentCounts(w,signal)).rejects.toThrow();});
it('rejects appointments from another calendar',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(Response.json({calendars:[{id:'c',locationId:'loc'}]})).mockResolvedValueOnce(Response.json({events:[{id:'a',calendarId:'other',locationId:'loc',startTime:w.start,appointmentStatus:'showed'}]})));await expect(liveAppointmentCounts(w,signal)).rejects.toThrow('scope');});

it('batches contacts while rejecting records outside the requested identities',async()=>{const f=vi.fn().mockResolvedValue(Response.json({opportunities:[{id:'bad',locationId:'loc',status:'open',contactId:'outside'}]}));vi.stubGlobal('fetch',f);await expect(liveContactOpportunities(['a','b'],signal)).rejects.toThrow('scope');expect(JSON.parse(f.mock.calls[0][1].body).filters[0].filters).toHaveLength(2);});
it('limits reverse search by status-change dates and also requests undated records',async()=>{const f=vi.fn().mockResolvedValue(Response.json({opportunities:[]}));vi.stubGlobal('fetch',f);await liveWonOpportunities(signal,w);const filters=JSON.parse(f.mock.calls[0][1].body).filters;expect(filters[1].group).toBe('OR');expect(filters[1].filters[1].operator).toBe('not_exists');expect(filters[1].filters[0].value.gte).toBe(w.start);});

it('reads calendars in the same group with one event request',async()=>{const f=vi.fn().mockResolvedValueOnce(Response.json({calendars:[{id:'a',locationId:'loc',groupId:'g'},{id:'b',locationId:'loc',groupId:'g'}]})).mockResolvedValueOnce(Response.json({events:[]}));vi.stubGlobal('fetch',f);expect((await liveAppointmentCounts(w,signal)).calendars).toBe(2);expect(f).toHaveBeenCalledTimes(2);expect(f.mock.calls[1][0]).toContain('groupId=g');expect(f.mock.calls[1][0]).not.toContain('calendarId');});

vi.mock('node:timers/promises',()=>({setTimeout:vi.fn(async()=>undefined)}));
it('backs off for the burst window instead of immediately repeating a rate-limited read',async()=>{
 const {setTimeout:pause}=await import('node:timers/promises');vi.mocked(pause).mockClear();
 const f=vi.fn().mockResolvedValueOnce(new Response(null,{status:429})).mockResolvedValueOnce(Response.json({messages:[],total:0,nextCursor:null}));vi.stubGlobal('fetch',f);
 expect((await liveCallCounts(w,signal)).total).toBe(0);expect(f).toHaveBeenCalledTimes(2);expect(vi.mocked(pause).mock.calls.some(c=>Number(c[0])>=9000)).toBe(true);
});
