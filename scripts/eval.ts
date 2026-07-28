// Retrieval + grounding eval harness (dependency-light).
//
// For each case in an eval set it:
//   1. retrieves within an org's data via hybridSearchScoped,
//   2. asks the grounded model to answer using only that context,
//   3. scores two things:
//        - CONTEXT RECALL: did a retrieved chunk contain the expected substring?
//        - FAITHFULNESS:  is the answer grounded — either it says "I don't know",
//                         or its content is supported by the retrieved text?
//      (ANSWERED is also reported: did the answer contain the expected substring?)
//
// Usage:  npm run eval -- [path-to-evalset.json]   (default evalset.example.json)
// Env (required):  NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY,
//                  and EVAL_ORG_ID (or ORG_ID) — the org to search.
// Env (optional):  ANTHROPIC_API_KEY (for Claude tiers), EVAL_MODEL (tier or model id).
//
// Eval set: JSON array of
//   { "question": string, "expectedAnswerContains": string, "expectedSourceType"?: string }

import { readFileSync } from "fs";
import { generateText } from "ai";
import { hybridSearchScoped } from "../src/lib/retrieval";
import { modelForTier } from "../src/lib/llm";
import { GROUNDED_SYSTEM, buildContext } from "../src/lib/prompts";

interface EvalCase {
  question: string;
  expectedAnswerContains: string;
  expectedSourceType?: string;
}

interface CaseResult {
  recall: boolean;
  answered: boolean;
  faithful: boolean;
  saidIdk: boolean;
  question: string;
}

const TOP_K = 8;

function requireEnv(name: string, ...fallbacks: string[]): string {
  for (const n of [name, ...fallbacks]) {
    if (process.env[n]) return process.env[n] as string;
  }
  throw new Error(`Missing required env var ${name}`);
}

async function evalCase(orgId: string, item: EvalCase): Promise<CaseResult> {
  const scope = {
    sourceTypes: item.expectedSourceType ? [item.expectedSourceType] : [],
    dataSourceIds: [] as string[],
    collectionIds: [] as string[],
  };

  const chunks = await hybridSearchScoped({ orgId, query: item.question, scope, matchCount: 40 });
  const top = chunks.slice(0, TOP_K);
  const context = buildContext(top.map((c) => ({ id: c.id, content: c.content })));

  const needle = item.expectedAnswerContains.toLowerCase();
  const recall = top.some((c) => c.content.toLowerCase().includes(needle));

  const { text } = await generateText({
    model: modelForTier(process.env.EVAL_MODEL),
    system: `${GROUNDED_SYSTEM}\n\nContext:\n${context}`,
    prompt: item.question,
  });
  const answer = text.trim();

  const saidIdk = /\b(i\s+don'?t\s+know|do\s+not\s+know|cannot\s+find|not\s+(in\s+the\s+)?(context|provided))/i.test(
    answer
  );
  const answered = answer.toLowerCase().includes(needle);
  // Simple faithfulness: either it refused, or it repeated the expected fact that
  // we already confirmed is in the retrieved context, or it broadly overlaps the context.
  const faithful = saidIdk || (answered && recall) || overlapsContext(answer, context);

  return { recall, answered, faithful, saidIdk, question: item.question };
}

// Fraction of the answer's significant words that appear in the retrieved context.
// A light proxy for "supported by the context" — no external dependencies.
function overlapsContext(answer: string, context: string): boolean {
  const ctx = new Set(tokenize(context));
  const words = tokenize(answer);
  if (words.length === 0) return false;
  const hits = words.filter((w) => ctx.has(w)).length;
  return hits / words.length >= 0.6;
}

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((w) => !STOPWORDS.has(w));
}

const STOPWORDS = new Set([
  "this", "that", "with", "from", "they", "have", "were", "what", "which", "their",
  "would", "there", "about", "these", "those", "then", "than", "them", "when",
  "your", "will", "into", "some", "such", "only", "also", "more", "most", "been",
]);

function pct(n: number, d: number): string {
  return d === 0 ? "  0%" : `${Math.round((n / d) * 100)}%`.padStart(4);
}

function yn(b: boolean): string {
  return b ? "Y" : "·";
}

async function main() {
  requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  requireEnv("OPENAI_API_KEY"); // embeddings
  const orgId = requireEnv("EVAL_ORG_ID", "ORG_ID");

  const path = process.argv[2] ?? "evalset.example.json";
  const cases = JSON.parse(readFileSync(path, "utf8")) as EvalCase[];
  if (!Array.isArray(cases) || cases.length === 0) throw new Error(`No cases in ${path}`);

  console.log(`\nRunning ${cases.length} eval case(s) against org ${orgId}\n`);

  const results: CaseResult[] = [];
  for (const item of cases) {
    try {
      results.push(await evalCase(orgId, item));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ! case failed: ${item.question} -> ${msg}`);
      results.push({ recall: false, answered: false, faithful: false, saidIdk: false, question: item.question });
    }
  }

  // Per-case table.
  console.log("  #   recall  answered  faithful  question");
  console.log("  --  ------  --------  --------  --------------------------------------");
  results.forEach((r, i) => {
    const num = String(i + 1).padStart(2);
    console.log(
      `  ${num}    ${yn(r.recall)}       ${yn(r.answered)}         ${yn(r.faithful)}      ${truncate(r.question, 44)}`
    );
  });

  // Summary.
  const n = results.length;
  const recall = results.filter((r) => r.recall).length;
  const answered = results.filter((r) => r.answered).length;
  const faithful = results.filter((r) => r.faithful).length;
  console.log("\n  Summary");
  console.log(`    Context recall : ${pct(recall, n)}  (${recall}/${n})`);
  console.log(`    Answered       : ${pct(answered, n)}  (${answered}/${n})`);
  console.log(`    Faithfulness   : ${pct(faithful, n)}  (${faithful}/${n})\n`);
}

function truncate(s: string, len: number): string {
  return s.length <= len ? s : s.slice(0, len - 1) + "…";
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
