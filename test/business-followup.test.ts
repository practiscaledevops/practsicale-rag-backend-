import {expect,it} from 'vitest';
import {businessFollowup} from '@/lib/connectors/business-followup';
import {planPayrollReports} from '@/lib/connectors/payroll-live';
import {renderPayrollFacts} from '@/lib/connectors/payroll-facts';
const question='how much team fahaad has closed this month?';
const follow='give me complete details of each closing';
const group=(label:string,closings:number,usd_minor:number)=>({label,closings,usd_minor,booked:0,showed:0,happened:0});
const source={report:'performance',from:'2026-11-01',through:'2026-11-17',date_basis:'Payroll attribution',fetched_at:'2026-11-17',data:{summary:{booked:1000,showed:100,no_show:900,closings:2,usd_minor:50000,absent_shows:null},teams:[group('Team Fahad',1,30000),group('Team Mike',1,20000)],setters:[],consultants:[],niches:[],undated_entries:0,sales:[{client:'Fahad client',owner:'Closer',ticket:'low_ticket',usd_minor:30000,recorded_date:'2026-11-10',team:'Team Fahad',setter:'Setter A',niche:null},{client:'Mike client',owner:'Closer',ticket:'low_ticket',usd_minor:20000,recorded_date:'2026-11-10',team:'Team Mike',setter:'Setter B',niche:null}]}};
it('routes a team closing question to one authoritative performance report',()=>{expect(planPayrollReports(question,'Asia/Karachi')?.reports).toEqual(['performance']);});
it('preserves team and month for the exact reported follow-up',()=>{const resolved=businessFollowup(follow,[{role:'user',content:question},{role:'assistant',content:'untrusted fabricated total'},{role:'user',content:follow}]);expect(resolved).toContain(question);const answer=renderPayrollFacts(resolved,source);expect(answer).toContain('Team Fahad — 1 closings · USD 300.00');expect(answer).toContain('Fahad client');expect(answer).toContain('Setter A');expect(answer).not.toContain('Mike client');expect(answer).not.toContain('Booked contacts');});
it('never substitutes company totals for an unknown team',()=>{expect(renderPayrollFacts('Team Zulu closings',source)).toContain('could not match');});
it('does not carry team scope into an explicitly different team',()=>{expect(businessFollowup('give details of Team Mike closings',[{role:'user',content:question}])).toBe('give details of Team Mike closings');});
it('does not use assistant answers as scope',()=>{expect(businessFollowup(follow,[{role:'assistant',content:question}])).toBe(follow);});
it('lists all individual deals when details are requested without context',()=>{const answer=renderPayrollFacts(follow,source);expect(answer).toContain('Fahad client');expect(answer).toContain('Mike client');expect(answer).not.toContain('Booked contacts');});
it('retains scope across repeated detail follow-ups',()=>{expect(businessFollowup('show details of those deals',[{role:'user',content:question},{role:'user',content:follow}])).toContain(question);});
it('marks source-assumed ticket classifications explicitly',()=>{const data={...source.data,sales:source.data.sales.map(r=>({...r,ticket_assumed:true}))};expect(renderPayrollFacts('Team Fahad closings',{...source,data})).toContain('assumed by Payroll');});
it('resolves Team Mike show-rate follow-up and uses the supplied Payroll rate',()=>{const q=businessFollowup('and what is show rate?',[{role:'user',content:'how much team mike has closed this month?'}]);expect(planPayrollReports(q,'Asia/Karachi')?.reports).toEqual(['performance']);const data={...source.data,teams:[{...group('Team Mike',1,20000),showed:2,happened:10,booked:20,show_rate:0.2}]};const answer=renderPayrollFacts(q,{...source,data});expect(answer).toContain('| Team Mike | 2 | 10 | 20.0% |');expect(answer).not.toContain('Fahad client');expect(answer).not.toContain('10.0%');});
it('does not manufacture a rate when the source rate is missing',()=>{expect(renderPayrollFacts('Team Mike show rate',source)).toContain('Not available');});
it('normalizes the reported consultant typo without a model',()=>{expect(businessFollowup('who is the top 1 consulant among them the best one',[])).toContain('consultant');});
it('carries the measure and period to another team without guessing totals',()=>{const q=businessFollowup('what about Team Mike?',[{role:'user',content:'how much Team Fahad has closed this month?'}]);expect(q).toContain('Team Mike has closed this month');expect(q).not.toContain('Fahad');});

it('resolves the reported David earnings to sales follow-up without retaining the pay intent',()=>{
 const q=businessFollowup('how much he closed this month?',[{role:'user',content:'how much david made earned this month'},{role:'assistant',content:'David invented surname'}]);
 expect(q).toBe('how much david closed this month?');expect(planPayrollReports(q,'Asia/Karachi')?.reports).toEqual(['performance']);
 const data={...source.data,sales:[{...source.data.sales[0],owner:'David M'},{...source.data.sales[1],owner:'Kate Melody'}]};
 const a=renderPayrollFacts(q,{...source,data});expect(a).toContain('David M — 1 closings');expect(a).not.toContain('Mike client');expect(a).not.toContain('Company-wide');
});
it('asks for a person rather than replacing an unresolved pronoun with company totals',()=>{expect(renderPayrollFacts('how much he closed this month?',source)).toContain('Which person');});
it('routes earned wording to Payroll without a model',()=>{expect(planPayrollReports('how much david made earned this month','Asia/Karachi')?.reports).toEqual(['payroll']);});
