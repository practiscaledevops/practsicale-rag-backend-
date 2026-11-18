type Turn = { role: string; content: string };

const recallQuestion = /^\s*(?:what|which)\s+(?:exact\s+)?([\p{L}\p{N}][\p{L}\p{N} '’-]{0,55}?)\s+did i\s+(?:give|tell|share|mention|provide|specify|say)(?:\s+(?:with you|to you|you))?(?:\s+(?:earlier|before|in this (?:chat|thread|conversation)))?[?.! ]*$/iu;
const repeatQuestion = /^\s*(?:repeat|quote|show) my (?:previous|last) (?:message|prompt)[?.! ]*$/i;

function quote(text: string): string {
  return "You wrote earlier:\n\n" + text.split("\n").map((line) => "> " + line).join("\n");
}

/** Exact recall from the user's retained turns. Assistant guesses and summaries
 * are deliberately excluded, and this path never certifies a business claim. */
export function recallUserStatement(turns: readonly Turn[]): string | null {
  const users = turns.filter((turn) => turn.role === "user");
  const question = users.at(-1)?.content.trim() ?? "";
  const previous = users.slice(0, -1).reverse();
  if (repeatQuestion.test(question)) {
    const prior = previous[0]?.content.trim();
    return prior ? quote(prior) : "There’s no earlier message from you in the history available for this chat.";
  }

  const label = recallQuestion.exec(question)?.[1].replace(/^(my|our|the) /i, "");
  if (!label) return null;

  // Match a labeled statement, rather than an earlier question about that
  // label. The original sentence is the answer, with attribution.
  const subject = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const statement = new RegExp(String.raw`^(?:(?:actually|update)[,:]?\s+)?(?:(?:my|our|the)\s+)?${subject}\b(?:\s+(?:in|for|of)\s+[^.!?:=]{1,65}?)?\s*(?:(?:is|was|are|were)\s+|[:=]\s*)\S`, "i");
  for (const turn of previous) {
    const lines = turn.content.split(/\r?\n|(?<=[.!?])\s+/u);
    for (const line of lines.reverse()) {
      const text = line.trim();
      if (text.length <= 700 && !text.endsWith("?") && statement.test(text)) return quote(text);
    }
  }
  return `I couldn’t find a ${label} you provided in the available history for this chat. Please share it again.`;
}
