/** Names are resolved against authorized report rows, never assistant prose. */
export function payrollPersonHint(query:string):string|null {
 const task=query.split('Follow-up requested:').at(-1)??query;
 const m=/\bhow much\s+(?:(?:has|did|does)\s+)?([a-z][a-z .'-]*?)\s+(?:(?:has|have)\s+)?(?:made|earn(?:ed|s|ing|ings)?|closed|sold|salary|commission)\b/i.exec(task)
  ?? /\b([a-z][a-z .'-]*?)['’]s\s+(?:pay|salary|earnings|commission|closings|sales)\b/i.exec(task)
  ?? /\b(?:earnings|salary|commission|pay)\s+(?:for|of)\s+([a-z][a-z .'-]*?)(?=\s+(?:this|last|in|for|during)\b|[?!]|$)/i.exec(task);
 const name=m?.[1]?.trim();
 return name&&!/\b(we|us|our|company|team|all|total|he|she|they|his|her|their)\b/i.test(name)?name:null;
}
export function resolvePayrollPerson(query:string,names:string[]) {
 const norm=(s:string)=>s.toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
 const unique=[...new Set(names)],hint=payrollPersonHint(query);
 if(hint){const key=norm(hint);const exact=unique.filter(n=>norm(n)===key);return {hint,matches:exact.length?exact:unique.filter(n=>norm(n).split(' ')[0]===key)};}
 const q=' '+norm(query)+' ';return {hint:null,matches:unique.filter(n=>q.includes(' '+norm(n)+' '))};
}
