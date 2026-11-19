/** Names are resolved against authorized report rows, never assistant prose. */
export function payrollPersonHint(query:string):string|null {
 const task=query.split('Follow-up requested:').at(-1)??query;
 const m=/\b(?:earnings?|salary|commissions?|pay|closings?|sales)\s+(?:for|of|by)\s+([a-z][a-z .'-]*?)(?=\s+(?:only|this|last|in|from|for|during|today|yesterday)\b|[,?!]|$)/i.exec(task)
  ?? /\bhow much\s+(?:(?:has|did|does)\s+)?([a-z][a-z .'-]*?)\s+(?:(?:has|have)\s+)?(?:made|earn(?:ed|s|ing|ings)?|closed|sold|salary|commission)\b/i.exec(task)
  ?? /\b([a-z][a-z .'-]*?)['’]s\s+(?:pay|salary|earnings?|commissions?|closings|sales)\b/i.exec(task);
 const name=m?.[1]?.trim();
 return name&&!/\b(we|us|our|company|team|all|total|he|she|they|his|her|their)\b/i.test(name)?name:null;
}
export function resolvePayrollPerson(query:string,names:string[], { strictHint = false } = {}) {
 const norm=(s:string)=>s.toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
 const unique=[...new Set(names)],hint=payrollPersonHint(query),q=' '+norm(query)+' ';
 if(strictHint&&hint){
  const key=norm(hint);
  const matches=unique.filter(n=>norm(n)===key||(!key.includes(' ')&&norm(n).split(' ')[0]===key));
  return {hint,matches};
 }
 const exact=unique.filter(n=>q.includes(' '+norm(n)+' '));
 if(exact.length)return {hint:exact.length===1?exact[0]:null,matches:exact};
 // Resolve a first name anywhere in the question from source identities, not a fixed sentence template.
 const firstNames=[...new Set(unique.map(n=>norm(n).split(' ')[0]))];
 const named=firstNames.filter(n=>n.length>2&&q.includes(' '+n+' ')&&!q.includes(' team '+n+' '));
 const aliases=unique.filter(n=>named.includes(norm(n).split(' ')[0]));
 if(named.length)return {hint:named.length===1?named[0]:hint,matches:aliases};
 if(hint){const key=norm(hint);return {hint,matches:unique.filter(n=>norm(n)===key)};}
 return {hint:null,matches:[]};
}
