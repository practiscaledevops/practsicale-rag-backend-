/** Count all whitespace-separated output words, including headings and citations. */
export function answerWordLimit(task:string):number|null {
 const m=/\b(under|fewer than|within|at most|no more than|max(?:imum)?(?: of)?)\s+(\d{1,4})\s+words?\b/i.exec(task);
 return m?Math.max(1,Number(m[2])-(/^(under|fewer than)$/i.test(m[1])?1:0)):null;
}
export const answerWords=(text:string)=>text.trim()?text.trim().split(/\s+/).length:0;
