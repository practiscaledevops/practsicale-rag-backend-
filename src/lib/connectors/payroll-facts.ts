import { z } from 'zod';

const cell = (v: unknown) => String(v ?? 'Not recorded').replace(/[|\n\r]/g, ' ').replace(/[<>]/g, '');
const table = (headers: string[], rows: unknown[][]) => '| '+headers.join(' | ')+' |\n| '+headers.map(()=> '---').join(' | ')+' |\n'+rows.map(r=>'| '+r.map(cell).join(' | ')+' |').join('\n');
const advisory = /\b(why|improve|recommend|strategy|write|coach|best|compare|comparison|versus|vs\.?|taxonomy|niche)\b/i;
export function renderPayrollFacts(query: string, source: {report:string;from:string;through:string;date_basis:string;fetched_at:string;data?:unknown}): string | null {
  if (advisory.test(query)) return null;
  const footer = '\n\nSource: [Sales Payroll](https://payroll.practicescalingsystems.com/admin). '+source.date_basis+'. Checked '+source.fetched_at+'.';
  if(source.report==='people') {
    if(/\b(yesterday|last|ago|20\d{2})\b/i.test(query)) return null;
    const data=z.object({active:z.number().int(),people:z.array(z.object({name:z.string().nullable(),role:z.string().nullable(),status:z.string()}))}).parse(source.data);
    const roles=['setter','consultant','closer'].filter(r=>new RegExp('\\b'+r+'s?\\b','i').test(query));
    const people=data.people.filter(p=>p.status==='active'&&(!roles.length||roles.includes(p.role??'')));
    const counts=roles.length?roles:['setter','consultant','closer','manager','qa'];
    let text=table(['Current active role','People'],counts.map(r=>[r,people.filter(p=>p.role===r).length]));
    text+='\n\nTotal active people across all roles: **'+data.active+'**. Roles are Payroll sales roles; job positions can differ.';
    if(/\b(names|list|who)\b/i.test(query)) text+='\n\n'+table(['Name','Sales role'],people.map(p=>[p.name,p.role]));
    return text+footer;
  }
  if(source.report==='fines'||source.report==='bonuses') {
    // A named-person or date-filtered request needs explicit filtering, never a
    // company-wide number dressed up as that person's amount.
    if(!/\b(total|summary|summarize|how many|how much|breakdown|all)\b/i.test(query)||/\b(yesterday|today|hour|day|employee|person|for [A-Z][a-z]+ [A-Z][a-z]+)\b/.test(query)) return null;
    const rows=z.array(z.object({status:z.string(),amount_minor:z.number().int().safe()})).parse(source.data);
    const statuses=[...new Set(rows.map(r=>r.status))].sort();
    const out=table(['Status','Records','Amount (PKR)'],statuses.map(status=>{const rs=rows.filter(r=>r.status===status);return [status,rs.length,(rs.reduce((s,r)=>s+r.amount_minor,0)/100).toLocaleString('en-US',{minimumFractionDigits:2})];}));
    return '**'+cell(source.report)+' — '+source.from.slice(0,7)+'**\n\n'+out+'\n\nThese are whole-month records, not proof of amounts paid or deducted. Pending and dismissed records are not confirmed deductions.'+footer;
  }
  if(source.report==='teams' && /\b(list|names|how many|membership|members|headcount)\b/i.test(query)) {
    const d=z.object({teams:z.array(z.object({name:z.string(),leader:z.object({name:z.string()}).nullable(),counts:z.object({members:z.number().int()})}))}).parse(source.data);
    return table(['Current team','Leader','Members'],d.teams.map(t=>[t.name,t.leader?.name??'Not assigned',t.counts.members]))+footer;
  }
  return null;
}
