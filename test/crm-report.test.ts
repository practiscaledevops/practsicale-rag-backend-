import {it,expect,vi,beforeEach} from 'vitest';
import {crmSalesReport} from '@/lib/connectors/crm-report';
import {liveCrmUsers,liveWonOpportunities} from '@/lib/connectors/live-crm';
vi.mock('@/lib/connectors/live-crm',()=>({liveCrmUsers:vi.fn(),liveWonOpportunities:vi.fn()}));
const signal=new AbortController().signal;
const read=(q='what is the total closing of adrian in november\nSource requested: what is in crm')=>crmSalesReport(q,'2026-11-01','2026-11-18','Asia/Karachi',signal);
beforeEach(()=>{vi.resetAllMocks();vi.mocked(liveCrmUsers).mockResolvedValue([{id:'adrian',name:'Adrian Cole'},{id:'kate',name:'Kate Melody'}]);});
it('filters exact source owner, uses local boundaries, separates undated and missing values',async()=>{
 vi.mocked(liveWonOpportunities).mockResolvedValue([
 {id:'a',locationId:'loc',status:'won',assignedTo:'adrian',lastStatusChangeAt:'2026-10-31T19:00:00Z',monetaryValue:100},
 {id:'b',locationId:'loc',status:'won',assignedTo:'adrian',lastStatusChangeAt:'2026-11-18T19:00:00Z',monetaryValue:200},
 {id:'c',locationId:'loc',status:'won',assignedTo:'adrian',monetaryValue:300},
 {id:'d',locationId:'loc',status:'won',assignedTo:'kate',lastStatusChangeAt:'2026-11-03T00:00:00Z',monetaryValue:999},
 {id:'e',locationId:'loc',status:'won',assignedTo:'adrian',lastStatusChangeAt:'2026-11-03T00:00:00Z'},
 ]);
 const answer=await read();expect(answer).toContain('Adrian Cole: 2 currently won');expect(answer).toContain('100.00 (1 missing values');expect(answer).toContain('1 additional currently won');expect(answer).not.toContain('999');expect(answer).toContain('Current assigned owner is not proof');expect(liveWonOpportunities).toHaveBeenCalledWith(signal,{start:'2026-10-31T19:00:00.000Z',end:'2026-11-18T19:00:00.000Z'});
});
it('asks for ambiguous CRM identities and performs no opportunity scan',async()=>{vi.mocked(liveCrmUsers).mockResolvedValue([{id:'a',name:'Adrian Cole'},{id:'b',name:'Adrian Smith'}]);expect(await read()).toContain('Which CRM owner');expect(liveWonOpportunities).not.toHaveBeenCalled();});
it('never substitutes company totals for missing or unsupported scope',async()=>{expect(await read('what is in crm')).toContain('Which CRM measure');expect(await read('Team Mike closings')).toContain('no broader total');expect(await read('closings of Unknown in November')).toContain('could not resolve');expect(liveWonOpportunities).not.toHaveBeenCalled();});
it('propagates incomplete CRM scans instead of claiming zero',async()=>{vi.mocked(liveWonOpportunities).mockRejectedValue(Error('incomplete'));await expect(read()).rejects.toThrow('incomplete');});
