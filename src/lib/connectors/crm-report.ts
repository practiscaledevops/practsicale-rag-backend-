import {liveCrmUsers,liveWonOpportunities} from './live-crm';
import {resolvePayrollPerson} from './payroll-person';
import {zonedDayBoundsUTC} from '@/lib/timezone';
import {ghlOpportunityCitation, ghlOpportunityIdPattern} from './ghl-opportunity';
const safe=(s:unknown)=>String(s??'Not recorded').replace(/[|<>\r\n]/g,' ');
/** Current CRM ownership is not interchangeable with Payroll's historical closing attribution. */
export async function crmSalesReport(query:string,from:string,through:string,timeZone:string,signal:AbortSignal){
 if(!/\b(closed|closings?|sales|won|deals?)\b/i.test(query))return 'Which CRM measure and person or team should I check? I have not substituted a company-wide report.';
 if(/\bteam\s+[a-z]|\b(ht|lt|high[ -]ticket|low[ -]ticket)\b/i.test(query))return 'This CRM view can verify current opportunity ownership and won status. It cannot establish Payroll team or ticket attribution; no broader total has been substituted. Specify the CRM owner for an owner-based report.';
 const users=await liveCrmUsers(signal);
 const person=resolvePayrollPerson(query,users.map(u=>u.name));
 const owners=users.filter(u=>person.matches.includes(u.name));
 if(owners.length!==1)return owners.length?'Which CRM owner do you mean: '+owners.map(u=>safe(u.name)+' ('+safe(u.id)+')').join(', ')+'?': 'I could not resolve a unique CRM owner from this question. Please give their full CRM name. No company-wide total has been substituted.';
 const owner=owners[0],w={start:zonedDayBoundsUTC(from,timeZone).startISO,end:zonedDayBoundsUTC(through,timeZone).endISO};
 const all=await liveWonOpportunities(signal,w);
 const owned=all.filter(o=>o.assignedTo===owner.id),dated=owned.filter(o=>{const t=Date.parse(o.lastStatusChangeAt??'');return Number.isFinite(t)&&t>=Date.parse(w.start)&&t<Date.parse(w.end)}),undated=owned.filter(o=>!Number.isFinite(Date.parse(o.lastStatusChangeAt??'')));
 const missingValues=dated.filter(o=>o.monetaryValue==null).length;
 const amount=dated.reduce((n,o)=>n+(o.monetaryValue??0),0);
 const rows=[...dated,...undated].map(o=>{
  const reference=ghlOpportunityIdPattern.test(o.id)?o.id+' ['+ghlOpportunityCitation(o.id)+']':o.id;
  return '| '+[o.name??o.contact?.name??o.id,reference,o.monetaryValue,o.lastStatusChangeAt??'Not recorded',dated.includes(o)?'In status-change period':'Date unknown; excluded from period count'].map(safe).join(' | ')+' |';
 }).join('\n');
 return '**GHL / CRM — '+safe(owner.name)+': '+dated.length+' currently won opportunities with a recorded status change in this period**\n\n'+
 'Period: '+from+' through '+through+' · '+safe(timeZone)+'. Current assigned owner: '+safe(owner.name)+'.\n\n'+
 'Sum of recorded opportunity values: '+amount.toFixed(2)+(missingValues?' ('+missingValues+' missing values; value total is incomplete)':'')+'. Currency is not supplied by this response, so no USD or PKR label is inferred.\n\n'+
 (rows?'| Opportunity | CRM ID | Recorded value | Last status change | Period treatment |\n| --- | --- | --- | --- | --- |\n'+rows+'\n\n':'')+
 undated.length+' additional currently won opportunities assigned to this owner have no usable status-change date and are excluded from the period count. '+all.filter(o=>!o.assignedTo).length+' candidates have no CRM owner and cannot be attributed to this person.\n\n'+
 'This is a live CRM owner/status report, not a verified historical closing ledger. Current assigned owner is not proof of who closed a sale; last status change is not independently verified as the closing date. Payroll-recognized sales and Call Scoring counts use different definitions and must not be added to this count.\n\nSource: GoHighLevel live opportunity search. Checked '+new Date().toISOString()+'.';
}
