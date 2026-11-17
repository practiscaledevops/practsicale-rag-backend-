import {AsyncLocalStorage} from 'node:async_hooks';
const budgets=new AsyncLocalStorage<{remaining:number}>();
export function withRequestBudget<T>(cap:number|undefined,work:()=>T):T {
 if(cap===undefined)return work();
 if(!Number.isFinite(cap)||cap<0||cap>1)throw new Error('Invalid request budget');
 return budgets.run({remaining:cap},work);
}
export const hasRequestBudget=()=>!!budgets.getStore();
export function reserveRequestCost(usd:number){
 const state=budgets.getStore();if(!state)return (_actual:number)=>{};
 if(!Number.isFinite(usd)||usd<0||usd>state.remaining)throw new Error('Request model budget reached');
 state.remaining-=usd;let settled=false;
 return (actual:number)=>{if(settled||!Number.isFinite(actual)||actual<0)return;settled=true;state.remaining+=usd-Math.max(0,actual);};
}
