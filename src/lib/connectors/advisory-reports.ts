import {requireSourceIdentity} from './source-access';
import {readLivePayroll, type planPayrollReports} from './payroll-live';
import {selectAdvisoryReport} from '@/lib/response-guidance';
/** Request-local identity only. Every source report still checks its live permissions. No cross-request cache. */
export async function readAdvisoryReports(query:string,plan:ReturnType<typeof planPayrollReports>,token:string|null,signal:AbortSignal){
 if(!plan||plan.unsupported)return [];
 const identity=requireSourceIdentity(token,signal).catch(()=>null);
 return Promise.all(plan.reports.map(async report=>{
  try{
   const email=await identity;if(!email)throw new Error('Source identity unavailable');
   signal.throwIfAborted();
   const result=selectAdvisoryReport(query,await readLivePayroll(report,email,plan.from,plan.through,signal));
   if(JSON.stringify(result).length>Math.floor(90000/plan.reports.length))return {report,available:false,reason:'Report too large for an answer; narrow the question. No partial sample is a company total.'};
   return {report,available:true,result};
  }catch{signal.throwIfAborted();return {report,available:false,reason:'Unavailable, unsupported scope or permission denied. This is not zero.'};}
 }));
}
