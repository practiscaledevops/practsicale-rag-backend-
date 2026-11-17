/** Reporting can be exact; advice and writing need synthesis over authorized evidence. */
export function needsSynthesis(query: string): boolean {
  const task = query.split('Follow-up requested:').at(-1) ?? query;
  return /\b(why|how (?:can|should|do) (?:we|i)|improv(?:e|ement|ements|ing)|recommend(?:ation|ations)?|advice|advise|strateg(?:y|ies|ic)|coach(?:ing)?|analy[sz](?:e|is)|diagnos(?:e|is)|explain|interpret|prioriti[sz]e|action plan|next steps?|what should|what would|write|draft|rewrite|revise|edit|shorten|expand|translate|polish|compose|brainstorm|script|campaign|copywriting|make (?:it|this|that)|turn (?:it|this|that))\b/i.test(task);
}

export const RESPONSE_GUIDANCE = `RESPONSE QUALITY — applies to coaching, analysis and writing in every mode:
Answer the latest request first. Treat previous turns as conversational context, not verified company evidence. Resolve follow-ups against the most recent relevant subject, team, period, audience and deliverable; a new explicit scope wins. For an edit, revise the existing draft rather than restarting the task. Answer every part of a compound request.
Use the authorized company reports and retrieved knowledge supplied below. Payroll is authoritative for its reporting definitions and reviewed outcomes; GHL evidence describes CRM state; scorecards and transcripts support call coaching. Never imply a source was checked unless supplied. State the scope, period and freshness of material figures. Preserve missing dates, denied access and incomplete coverage as limitations, never zeros. Do not treat historical chat numbers as current evidence.
For analysis, lead with the main finding, explain what the evidence supports, then implications and the next decision. Separate observation from hypothesis: correlation and a ranking do not establish causation or overall quality. Name the ranking measure. Use tables only where they help comparison, not as the whole answer.
For coaching, connect each priority to a supported observation, propose a concrete action or example script, suggest an owner role and review interval, and say how to measure progress. Owner, interval, targets and experiments are proposals unless recorded. Prioritize two or three actions over a generic checklist. Do not invent numerical improvement targets or promise uplift. Use the exact Payroll metric definition; elapsed meeting contacts are not all scheduled bookings. If evidence cannot establish the cause, give testable hypotheses and what would distinguish them. Never invent call quotes or diagnose an employee from aggregate totals alone. Do not turn playbook beliefs about prospect psychology into established facts. Attribute unverified playbook claims as hypotheses or omit them.
For writing, deliver the requested finished piece first, matching audience, channel, tone and length. Use company voice and approved claims when supplied. Preserve the brief across revisions and vary the angle for a fresh version. Do not expose internal payroll, employee performance, client identities or confidential CRM details in public-facing copy without explicit authorization. Use aggregate or anonymized insights where appropriate. Invent no testimonials, founder experiences, case studies, guarantees or results. Use placeholders for indispensable missing facts; label hypothetical examples. Do not turn a writing request into a report or an explanation of how to write.
Be useful when evidence is limited: identify the specific missing fact and offer clearly proposed advice or a draft that does not depend on it. Ask one focused question only when the missing information prevents a useful answer. Keep factual claims cited and distinguish recommendations from company policy.`;

/** Aggregate business advice is not an implicit request to read every sales call. */
export function payrollAggregateOnly(query: string): boolean {
 return /\b(payroll|teams?|setters?|show[ -]?rate|appointments?|attendance|fines?)\b/i.test(query)
   && !/\b(calls?|transcripts?|scorecards?|recordings?|objections?|quotes?)\b/i.test(query);
}

/** Keep the complete requested team aggregate; do not send unrelated client rows as advice context. */
export function selectAdvisoryReport<T extends {report:string;data?:unknown}>(query:string,source:T):T {
 if(source.report!=='performance'||!needsSynthesis(query)||!source.data||typeof source.data!=='object')return source;
 const d=source.data as Record<string,unknown>;
 if(!Array.isArray(d.teams))return source;
 const matches=d.teams.filter((t:any)=>typeof t?.label==='string'&&query.toLowerCase().includes(t.label.toLowerCase()));
 if(matches.length!==1||/\b(each|clients?|prospects?|all teams|compare|comparison|versus|vs)\b/i.test(query))return source;
 return {...source,data:{teams:matches,company_outcome_warning:(d.summary as any)?.absent_shows??null,metric_definitions:{showed:'Payroll-reviewed show-ups',happened:'Elapsed meeting contacts, including non-show outcomes; not all scheduled bookings. The difference happened minus showed is not necessarily confirmed no-shows: unresolved or unfiled outcomes may remain',show_rate:'Reviewed show-ups divided by elapsed meeting contacts. Multiply by 100 to express a percentage.',booked:'Separate booking count; do not substitute it for the show-rate denominator'},evidence_selection:'Complete aggregate for the named team only. Other teams, individual bookings and sales rows are not supplied; no cause or individual outcome can be inferred.'}};
}

/** Leave generous token room while honoring an explicit short-draft word ceiling. */
export function requestedAnswerTokenLimit(task:string,configured:number):number {
 const m=/\b(?:under|within|at most|no more than|max(?:imum)?(?: of)?)\s+(\d{1,4})\s+words?\b/i.exec(task);
 return m?Math.min(configured,Math.max(512,Number(m[1])*4+256)):configured;
}
