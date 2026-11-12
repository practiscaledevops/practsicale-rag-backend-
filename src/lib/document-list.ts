export const DOCUMENT_PAGE_SIZE = 50;
export const DOCUMENT_SOURCE_FILTERS = ["all", "document", "transcript", "call_score", "coaching"] as const;
export interface DocumentListState { page:number; query:string; sourceType:string; }
export function documentListState(params:Record<string,string|string[]|undefined>):DocumentListState {
  const single=(v:string|string[]|undefined)=>typeof v==="string"?v:"";
  const page=Number(single(params.page));
  const sourceType=single(params.type);
  return {page:Number.isInteger(page)&&page>0?Math.min(page,100000):1,query:single(params.q).trim().slice(0,200),sourceType:(DOCUMENT_SOURCE_FILTERS as readonly string[]).includes(sourceType)?sourceType:"all"};
}
export function documentListHref(state:DocumentListState):string {
  const p=new URLSearchParams();
  if(state.query.trim())p.set("q",state.query.trim());
  if(state.sourceType!=="all")p.set("type",state.sourceType);
  if(state.page>1)p.set("page",String(state.page));
  return `/dashboard/documents${p.size?`?${p}`:""}`;
}
/** Quote PostgREST filter values so punctuation cannot add a filter/operator. */
export function documentSearchFilter(query:string):string {
  const literal=query.replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/[%_]/g,"\\$&");
  return ["title","metadata->>category","metadata->>owner","metadata->>source_owner","metadata->>author"].map(field=>`${field}.ilike."%${literal}%"`).join(",");
}
