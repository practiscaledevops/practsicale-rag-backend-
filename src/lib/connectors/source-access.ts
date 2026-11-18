import { z } from "zod";

const payroll = "https://zxifguiyvzrafrqskeyq.supabase.co";
/** Validates the actual chatbot session, then checks the source account each time.
 * Never accepts email, role or permissions supplied in the chat body. */
type Permission = "dashboard.view" | "pipeline.view" | "employees.view" | "teams.view" | "reporting.view" | "fines_bonuses.view" | "pay_rules.view" | "attendance.view";
async function read(target:string,headers:Record<string,string>,signal:AbortSignal){
 const response=await fetch(target,{headers,signal,cache:'no-store',redirect:'error'});
 if(!response.ok)throw Error('Source access unavailable');return response.json();
}
/** Identity only. Use solely when the source gateway rechecks its own permissions. */
async function verifiedSource(token:string|null,signal:AbortSignal){
 const url=process.env.CHATBOT_AUTH_URL,anon=process.env.CHATBOT_AUTH_PUBLISHABLE_KEY;
 if(!token||token.length>12000||!url||!anon||!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url))throw Error('Source access unavailable');
 const deadline=AbortSignal.any([signal,AbortSignal.timeout(8000)]);
 const headers={apikey:anon,Authorization:'Bearer '+token};
 const user=z.object({id:z.string().uuid(),email:z.string().email(),email_confirmed_at:z.string().min(1)}).parse(await read(url+'/auth/v1/user',headers,deadline));
 const aliases=z.record(z.string().uuid(),z.string().email()).parse(JSON.parse(process.env.SOURCE_ACCOUNT_ALIASES??'{}'));
 return {email:(aliases[user.id]??user.email).trim().toLowerCase(),user,headers,url};
}
async function activeProfile(identity:Awaited<ReturnType<typeof verifiedSource>>,deadline:AbortSignal,adminOnly=false){
 const {user,headers,url}=identity;
 const columns=adminOnly?'is_active,role':'is_active';
 const [profile]=z.array(z.object({is_active:z.boolean(),role:z.string().optional()})).length(1).parse(await read(url+'/rest/v1/profiles?select='+columns+'&id=eq.'+user.id,headers,deadline));
 if(!profile.is_active||(adminOnly&&profile.role!=='admin'&&profile.role!=='super_admin'))throw Error('Source access denied');
}
export async function requireSourceIdentity(token:string|null,signal:AbortSignal){
 const identity=await verifiedSource(token,signal);await activeProfile(identity,signal);return identity.email;
}
export async function requireSourcePermission(token:string|null,permission:Permission|Permission[],signal:AbortSignal,options?:{adminOnly:boolean}){
 const key=process.env.PAYROLL_REPORTS_SERVER_KEY;if(!key)throw Error('Source access unavailable');
 const deadline=AbortSignal.any([signal,AbortSignal.timeout(8000)]);
 const identity=await verifiedSource(token,deadline),sourceEmail=identity.email;
 const headers={apikey:key,...(key.startsWith('eyJ')?{Authorization:'Bearer '+key}:{})};
 const query=new URLSearchParams({select:'role,role_id,active,admin_roles!admin_users_role_id_fkey(permissions)',email:'eq.'+sourceEmail,limit:'2'});
 const [,accountData]=await Promise.all([activeProfile(identity,deadline,options?.adminOnly),read(payroll+'/rest/v1/admin_users?'+query,headers,deadline)]);
 const accounts=z.array(z.object({role:z.string().nullable(),role_id:z.string().uuid().nullable(),active:z.boolean(),admin_roles:z.object({permissions:z.array(z.string())}).nullable()})).length(1).parse(accountData);
 const account=accounts[0];if(!account.active)throw Error('Source access denied');
 if(account.role_id){
 const roles=z.array(z.object({permissions:z.array(z.string())})).length(1).parse(account.admin_roles?[account.admin_roles]:[]);
 if(roles[0].permissions.includes('*')||(Array.isArray(permission)?permission:[permission]).every(p=>roles[0].permissions.includes(p)))return sourceEmail;
 }else if(account.role==='admin')return sourceEmail;
 throw Error('Source access denied');
}
