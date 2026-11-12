import { describe,it,expect } from "vitest";
import { documentListState,documentListHref,documentSearchFilter,DOCUMENT_PAGE_SIZE } from "@/lib/document-list";
describe("bounded document browsing",()=>{
  it("keeps searches and pages restorable beyond the former 1000-row cutoff",()=>{
    const state=documentListState({page:"24",q:"Lena Bhim",type:"transcript"});
    expect((state.page-1)*DOCUMENT_PAGE_SIZE).toBe(1150);
    expect(documentListHref(state)).toBe("/dashboard/documents?q=Lena+Bhim&type=transcript&page=24");
  });
  it("validates untrusted page and type values",()=>{
    expect(documentListState({page:"-2",type:"secret_table",q:["a","b"]})).toEqual({page:1,query:"",sourceType:"all"});
    expect(documentListState({page:"Infinity",q:" x "}).query).toBe("x");
    expect(documentListState({page:"1.5"}).page).toBe(1);
  });
  it("quotes commas and operator-looking input inside literal search values",()=>{
    const filter=documentSearchFilter('x),org_id.eq.other,"%_');
    expect(filter.startsWith('title.ilike."%')).toBe(true);
    expect(filter).toContain('other,\\"\\%\\_');
    expect(filter.split('.ilike.')).toHaveLength(6);
  });
});
