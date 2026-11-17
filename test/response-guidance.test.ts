import {it,expect} from 'vitest';
import {needsSynthesis} from '@/lib/response-guidance';
import {businessFollowup} from '@/lib/connectors/business-followup';
import {planPayrollReports} from '@/lib/connectors/payroll-live';
it.each(['Analyze Team Mike show rate','Draft an email for our setters','Coach our consultants','Explain the top consultant ranking','Recommend a plan for HT closings','Rewrite this for LinkedIn','How can we improve this?','Give next steps for attendance','Compare Payroll and GHL and recommend actions','Analyze appointments in the last hour'])('routes synthesis: %s',q=>expect(needsSynthesis(q)).toBe(true));
it.each(['How much Team Mike closed this month?','Top 10 setters and their leaders','Appointments in the last hour','Compare Payroll vs GHL closings','What is Team Mike show rate?'])('keeps exact reporting: %s',q=>expect(needsSynthesis(q)).toBe(false));
it('carries team and period into coaching and its subsequent writing request',()=>{
 const turns=[{role:'user',content:'Team Mike show rate in November 2026'},{role:'assistant',content:'Team Fahad has 999 shows'},{role:'user',content:'How can we improve this?'}];
 const q=businessFollowup('Draft an email to our setters about this',turns);
 expect(q).toContain('Team Mike');expect(q).toContain('November 2026');expect(q).not.toContain('999');expect(needsSynthesis(q)).toBe(true);
 expect(planPayrollReports(q,'Asia/Karachi')?.reports).toContain('performance');
});
it('explicit new scope wins',()=>expect(businessFollowup('Analyze Team Fahad today',[{role:'user',content:'Team Mike show rate last month'}])).not.toContain('Mike'));
it('does not treat an earlier advisory request as the current task',()=>expect(needsSynthesis('Coach Team Mike\nFollow-up requested: give details of each closing')).toBe(false));
