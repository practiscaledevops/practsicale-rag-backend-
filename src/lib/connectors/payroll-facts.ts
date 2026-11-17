import { z } from 'zod';

const cell = (v: unknown) => String(v ?? 'Not recorded').replace(/[|\n\r]/g, ' ').replace(/[<>]/g, '');
const table = (headers: string[], rows: unknown[][]) => '| '+headers.join(' | ')+' |\n| '+headers.map(()=> '---').join(' | ')+' |\n'+rows.map(r=>'| '+r.map(cell).join(' | ')+' |').join('\n');
const advisory = /\b(why|improve|recommend|strategy|write|coach|best|compare|comparison|versus|vs\.?|taxonomy|niche)\b/i;
export function renderPayrollFacts(query: string, source: {report:string;from:string;through:string;date_basis:string;fetched_at:string;data?:unknown}): string | null {
  if (advisory.test(query) && !(source.report === 'performance' && !/\b(why|improve|recommend|strategy|write|coach|compare|comparison|versus|vs)\b/i.test(query))) return null;
  const footer = '\n\nSource: [Sales Payroll](https://payroll.practicescalingsystems.com/admin). '+source.date_basis+'. Checked '+source.fetched_at+'.';
  if(source.report==='performance') {
    const group=z.object({label:z.string(),booked:z.number(),showed:z.number(),happened:z.number(),closings:z.number(),usd_minor:z.number()});
    const d=z.object({summary:z.object({booked:z.number(),showed:z.number(),no_show:z.number(),closings:z.number(),usd_minor:z.number(),absent_shows:z.string().nullable()}),setters:z.array(group),teams:z.array(group),consultants:z.array(group),niches:z.array(group),undated_entries:z.number(),sales:z.array(z.object({client:z.string().nullable(),owner:z.string(),ticket:z.enum(['high_ticket','low_ticket']),usd_minor:z.number(),recorded_date:z.string().nullable(),niche:z.string().nullable(),team:z.string().nullable().optional(),setter:z.string().nullable().optional()}))}).parse(source.data);
    if(d.summary.absent_shows) return 'Payroll cannot verify show-up outcomes for this period: '+cell(d.summary.absent_shows)+footer;
    const normalize=(v:string)=>v.toLowerCase().replace(/([a-z])\1+/g,'$1').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
    const mentionedTeams=d.teams.filter(t=>normalize(query).includes(normalize(t.label)));
    const namedTeam=/\bteam\s+(?!performance\b|closings?\b|sales\b|totals?\b|members?\b|leaders?\b|has\b|have\b|this\b|report\b)([a-z]+)/i.exec(query);
    if(namedTeam&&!mentionedTeams.length)return 'I could not match the requested team to Payroll. Available teams: '+d.teams.map(t=>cell(t.label)).join(', ')+'. No company-wide total was substituted.'+footer;
    if(mentionedTeams.length&&d.sales.some(r=>r.team===undefined))return 'Payroll has not supplied team attribution for the individual closings. I cannot verify the requested team breakdown yet.'+footer;
    const owners=[...new Set(d.sales.map(r=>r.owner))].filter(n=>query.toLowerCase().includes(n.toLowerCase()));
    const bothTickets=/\b(ht|high[ -]ticket)\b/i.test(query)&&/\b(lt|low[ -]ticket)\b/i.test(query);
    const ticket=bothTickets?null:/\b(ht|high[ -]ticket)\b/i.test(query)?'high_ticket':/\b(lt|low[ -]ticket)\b/i.test(query)?'low_ticket':null;
    const sales=d.sales.filter(r=>(!owners.length||owners.includes(r.owner))&&(!ticket||r.ticket===ticket)&&(!mentionedTeams.length||mentionedTeams.some(t=>t.label===r.team)));
    if(ticket||owners.length||mentionedTeams.length||/\b(names|clients|taxonomy|closing|closings|closed|sales)\b/i.test(query)) {
      const title=(mentionedTeams.length?mentionedTeams.map(t=>t.label).join(', '):owners.length?owners.join(', '):'Company-wide')+(ticket?' · '+ticket.replace('_',' '):'');
      if(/\b(taxonomy|niche)\b/i.test(query)) {
        const groups=new Map<string,{owner:string;niche:string;count:number;minor:number}>();
        for(const r of sales){const key=r.owner+'\u0000'+(r.niche??'Not attributed');const g=groups.get(key)??{owner:r.owner,niche:r.niche??'Not attributed',count:0,minor:0};g.count++;g.minor+=r.usd_minor;groups.set(key,g);}
        return '**Consultant/closer sales by niche — '+source.from+' to '+source.through+'**\n\n'+table(['Consultant/closer','Niche','Closings','Closed USD'],[...groups.values()].sort((a,b)=>b.minor-a.minor).map(g=>[g.owner,g.niche,g.count,(g.minor/100).toFixed(2)]))+'\n\nRanked by closed USD; this does not establish coaching quality. Niche comes from the attributed booking and can be missing.'+footer;
      }
      return '**'+cell(title)+' — '+sales.length+' closings · USD '+(sales.reduce((n,r)=>n+r.usd_minor,0)/100).toFixed(2)+'**\n\n'+table(['Client','Closed by','Ticket','USD','Recorded date','Setter','Attributed team'],sales.map(r=>[r.client,r.owner,r.ticket,(r.usd_minor/100).toFixed(2),r.recorded_date??'Not recorded',r.setter??'Not attributed',r.team??'Not attributed']))+'\n\nOne row per closing, not per unique client. Undated admin entries belong to the Payroll month; no exact closing date is inferred.'+footer;
    }
    const groupName=/\bteams?\b/i.test(query)?'teams':/\bniches?\b/i.test(query)?'niches':/\b(consultants?|closers?)\b/i.test(query)?'consultants':/\bsetters?\b/i.test(query)?'setters':null;
    let text='**Payroll performance — '+source.from+' to '+source.through+'**\n\n'+table(['Metric','Total'],[['Booked contacts',d.summary.booked],['Reviewed show-ups',d.summary.showed],['Reviewed/filed no-shows',d.summary.no_show],['Closings',d.summary.closings],['Closed value (USD)',(d.summary.usd_minor/100).toFixed(2)]]);
    if(groupName){const bySales=groupName==='consultants'||/\b(closed|closings|sales|revenue)\b/i.test(query);const rows=[...d[groupName]].sort((a,b)=>bySales?b.usd_minor-a.usd_minor:b.showed-a.showed);
      text+='\n\n'+table([groupName,'Booked contacts','Show-ups','Closings','Closed USD'],rows.map(r=>[r.label,groupName==='consultants'?'Not attributed':r.booked,groupName==='consultants'?'Not attributed':r.showed,r.closings,(r.usd_minor/100).toFixed(2)]));
      text+='\n\nSorted by '+(bySales?'closed USD':'reviewed show-ups')+'. This ranking is not an overall quality judgment. Unattributed sales remain in the company total.';
    }
    return text+'\n\nNo-shows are missed meetings, not missed phone calls. '+d.undated_entries+' admin entries have no exact closing date; they cannot be assigned to a day or hour. Booked contacts and paid appointments are different measures.'+footer;
  }
  if(source.report==='attendance') {
    const d=z.object({date:z.string(),counts:z.record(z.number()),unmeasurable:z.number()}).parse(source.data);
    return '**Attendance — '+d.date+'**\n\n'+table(['Recorded state','People'],[...Object.entries(d.counts),['No measurable position',d.unmeasurable]])+'\n\nNot scanned yet does not prove absence. This is the recorded state, not an inferred attendance ruling.'+footer;
  }
  if(source.report==='rules') {
    const d=z.object({active_criteria:z.object({version:z.number(),effective_from:z.string(),criteria_text:z.string()}).nullable(),operational_rules:z.array(z.object({rule_key:z.string(),enabled:z.boolean(),effective_from:z.string()}))}).parse(source.data);
    return '**Current Payroll rules**\n\n'+(d.active_criteria?'Version '+d.active_criteria.version+', effective '+d.active_criteria.effective_from+'\n\n'+d.active_criteria.criteria_text.replace(/[<>]/g,''):'No active criteria recorded.')+'\n\n'+table(['Operational rule','Enabled','Effective from'],d.operational_rules.map(r=>[r.rule_key,r.enabled?'Yes':'No',r.effective_from]))+'\n\nCurrent configuration does not prove how an old payslip was calculated. Person-specific overrides are not covered here.'+footer;
  }
  if(source.report==='payroll' && /\b(total|summary|cost)\b/i.test(query)) {
    const d=z.object({totals:z.object({payroll_minor:z.number(),payslips:z.number()}),bill:z.object({run_status:z.string(),last_recalculated_at:z.string().nullable(),composition_reconciles:z.boolean()})}).parse(source.data);
    return '**Payroll cost: PKR '+(d.totals.payroll_minor/100).toLocaleString('en-US',{minimumFractionDigits:2})+' across '+d.totals.payslips+' payslips.**\n\nRun status: '+cell(d.bill.run_status)+'. Last recalculated: '+cell(d.bill.last_recalculated_at)+'.'+(!d.bill.composition_reconciles?'\n\nPayroll reports that its line-item composition does not reconcile with this total; investigate the source bill before treating the breakdown as reconciled.':'')+footer;
  }
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
