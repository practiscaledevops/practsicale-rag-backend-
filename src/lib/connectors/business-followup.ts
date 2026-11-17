/** Resolve narrow drill-down follow-ups from user turns only. Never use assistant prose as evidence. */
function inheritScope(query:string,prior:string){
 if(!/\b(details?|breakdown|each|those|these|them)\b/i.test(query)||! /\b(closings?|sales|deals?|those|these|them)\b/i.test(query))return query;
 // An explicit scope is a new request, not a reason to reuse another team's scope.
 if(/\bteam\s+[a-z]|\b(consultant|closer|setter)\s+[a-z]|\b(company.wide|all teams)\b/i.test(query))return query;

 if(!/\b(closed|closings?|sales|deals?)\b/i.test(prior))return query;
 // Do not override a newly requested date or ticket filter with an old one.
 if(/\b(today|yesterday|month|week|20\d{2}|january|february|march|april|may|june|july|august|september|october|november|december|ht|lt|high.ticket|low.ticket)\b/i.test(query))return query;
 return prior+'\nFollow-up requested: '+query;
}

export function businessFollowup(query:string,turns:{role:string;content:string}[]){
 const users=turns.filter(t=>t.role==='user');if(users.at(-1)?.content===query)users.pop();
 let previous='';for(const turn of users.slice(-40))previous=inheritScope(turn.content,previous).slice(-16000);
 return inheritScope(query,previous);
}
