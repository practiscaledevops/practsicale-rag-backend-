import {payrollPersonHint} from './payroll-person';
import { needsSynthesis } from '@/lib/response-guidance';
/** Resolve narrow drill-down follow-ups from user turns only. Never use assistant prose as evidence. */
function inheritScope(query:string,prior:string){
 // Source-only switches retain the last user-requested subject and dates.
 if(prior && /^(?:(?:and|also|then|now)\s+)?(?:(?:what\s+(?:is|does)|how about|what about|check|show(?: me)?|in|from)\s+)?(?:(?:in|does|the)\s+)*(?:ghl|crm|call[ -]scoring(?: app)?|payroll)(?:\s+(?:say|says|show|shows))?[?.! ]*$/i.test(query.trim()))
   return prior.split('\nSource requested:')[0]+'\nSource requested: '+query;
 const priorPerson=payrollPersonHint(prior);
 if(priorPerson&&/^[a-z]+(?:[ .'-]+[a-z]+){0,2}[.]?$/i.test(query.trim())&&!/\b(yes|no|okay|ok|thanks|today|yesterday|month|week|all|everyone|show|tell|how|what|why|and|please)\b/i.test(query)){
   return prior.replace(priorPerson,query.trim());
 }

 if(/\b(he|she|his|her)\b/i.test(query)){
  const person=payrollPersonHint(prior);
  if(person)query=query.replace(/\b(he|she)\b/gi,person).replace(/\b(his|her)\b/gi,person+"'s");
 }

 // Resolve short advisory/edit follow-ups from user intent, never assistant claims.
 if(prior && needsSynthesis(query) && /\b(it|this|that|these|those|them|we|our)\b/i.test(query)
   && !/\bteam\s+[a-z]|\b(company.wide|all teams|today|yesterday|month|week|20\d{2})\b/i.test(query))
   return prior+'\nFollow-up requested: '+query;

 const otherTeam=/^(?:(?:and|what about|how about|also|now|for)\s+)?(team\s+[a-z]+(?:\s+[a-z]+)?)[?.! ]*$/i.exec(query.trim());
 if(otherTeam&&/\b(closed|closings?|sales|show[ -]?rate)\b/i.test(prior)&&/\bteam\s+[a-z]+/i.test(prior)){
  // Keep the requested measure and dates; replace only the previously named team.
  return prior.replace(/\bteam\s+[a-z]+(?:\s+(?!has\b|have\b|closed\b|this\b|last\b|in\b|for\b|show\b|closings?\b)[a-z]+)?/gi,otherTeam[1]);
 }

 const metricFollowup=/\b(show[ -]?rate)\b/i.test(query);
 if(!metricFollowup&&(!/\b(details?|breakdown|each|those|these|them)\b/i.test(query)||! /\b(closings?|sales|deals?|those|these|them)\b/i.test(query)))return query;
 // An explicit scope is a new request, not a reason to reuse another team's scope.
 if(/\bteam\s+[a-z]|\b(consultant|closer|setter)\s+[a-z]|\b(company.wide|all teams)\b/i.test(query))return query;

 if(!/\b(closed|closings?|sales|deals?|show[ -]?rate)\b/i.test(prior))return query;
 // Do not override a newly requested date or ticket filter with an old one.
 if(/\b(today|yesterday|month|week|20\d{2}|january|february|march|april|may|june|july|august|september|october|november|december|ht|lt|high.ticket|low.ticket)\b/i.test(query))return query;
 return prior+'\nFollow-up requested: '+query;
}

export function businessFollowup(query:string,turns:{role:string;content:string}[]){
 const users=turns.filter(t=>t.role==='user');if(users.at(-1)?.content===query)users.pop();
 const normalize=(s:string)=>{
   const words:Record<string,string>={hw:'how',mch:'much',earnd:'earned',eraned:'earned',earnned:'earned',clsoed:'closed',clsoings:'closings',closngs:'closings',salry:'salary',commision:'commission',mnth:'month',montth:'month',dis:'this',consulant:'consultant',consulants:'consultants'};
   return s.replace(/\b[a-z]+\b/gi,w=>words[w.toLowerCase()]??w).replace(/\bhowmuch\b/gi,'how much');
 };
 query=normalize(query);
 let previous='';for(const turn of users.slice(-40))previous=inheritScope(normalize(turn.content),previous).slice(-16000);
 return inheritScope(query,previous);
}

/** Latest explicit source wins; earlier source-switch text is not the current request. */
export function requestedBusinessSource(query:string) {
 const task=(query.split('Follow-up requested:').at(-1)??query).split('Source requested:').at(-1)??query;
 if(/\b(ghl|crm)\b/i.test(task))return 'crm';
 if(/\bcall[ -]scoring\b/i.test(task))return 'call-scoring';
 if(/\bpayroll\b/i.test(task))return 'payroll';
 return null;
}
