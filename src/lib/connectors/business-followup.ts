import {payrollPersonHint} from './payroll-person';
import { needsSynthesis } from '@/lib/response-guidance';
/** Resolve narrow drill-down follow-ups from user turns only. Never use assistant prose as evidence. */
function inheritScope(query:string,prior:string){
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
 const normalize=(s:string)=>s.replace(/\bconsulants?\b/gi,m=>m.toLowerCase().endsWith('s')?'consultants':'consultant');
 query=normalize(query);
 let previous='';for(const turn of users.slice(-40))previous=inheritScope(normalize(turn.content),previous).slice(-16000);
 return inheritScope(query,previous);
}
