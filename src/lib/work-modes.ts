// Work modes — "which expert am I talking to". ONE Brain, many jobs: a mode is
// a retrieval POLICY (which intelligence lanes matter, which domains/types get
// boosted) plus a reasoning OVERLAY appended to the grounding prompt. It never
// creates a separate knowledge base.
//
// Auto is the default: the orchestrator detects the mode from the request and a
// manual selection overrides it. Legacy mode ids (sales, media, strategy,
// decision_maker, ceo) stay valid as aliases so existing clients/prompts keep
// working. Pure data + helpers — safe for client and server.

import type { IntelligenceClass } from "./intelligence-taxonomy";

export type WorkMode =
  | "auto"
  | "general"
  // Business
  | "ceo_advisor"
  | "strategy_advisor"
  | "sales_coach"
  | "marketing_advisor"
  | "offer_architect"
  | "cs_advisor"
  | "management_coach"
  | "hiring_advisor"
  | "operations_advisor"
  // Content
  | "content_strategist"
  | "copywriter"
  | "ceo_content"
  | "distribution_strategist"
  // Build
  | "training_builder"
  | "sop_builder"
  // Analysis
  | "decision_memo"
  | "research_analyst";

export type ModeGroup = "general" | "business" | "content" | "build" | "analysis";

/** CREATE = make it for me · ADVISE = help me decide · BUILD = make the whole thing I can use. */
export type IntentKind = "create" | "advise" | "build" | "analyze" | "lookup";

export type Lane = "reality" | "learning" | "playbook" | "platform" | "performance";

export const LANES: Lane[] = ["reality", "learning", "playbook", "platform", "performance"];

export const LANE_CLASS: Record<Lane, IntelligenceClass[]> = {
  reality: ["business_reality"],
  learning: ["organizational_learning"],
  playbook: ["playbook"],
  platform: ["platform_intelligence"],
  performance: ["performance_memory"],
};

export const LANE_LABEL: Record<Lane, string> = {
  reality: "Business Reality",
  learning: "Organizational Learning",
  playbook: "Playbooks",
  platform: "Platform Intelligence",
  performance: "Performance Memory",
};

export interface RetrievalPolicy {
  /** Lane weights in [0,1]; 0 = do not search that lane. */
  lanes: Record<Lane, number>;
  /** Domains to boost (soft — never a hard filter). */
  preferredDomains: string[];
  /** Object types to boost (soft). */
  preferredTypes: string[];
  /** Also search the raw archive (analysts only). */
  includeRaw?: boolean;
}

export interface WorkModeDef {
  id: WorkMode;
  label: string;
  group: ModeGroup;
  hint: string;
  intent: IntentKind;
  /** Restricted modes require an exec role or a granted feature (gated by the spoke). */
  restricted?: boolean;
  policy: RetrievalPolicy;
  /** The behaviour overlay (appended under the ACTIVE WORK MODE header). */
  instruction: string;
}

const lanes = (
  reality: number,
  learning: number,
  playbook: number,
  platform = 0,
  performance = 0
): Record<Lane, number> => ({ reality, learning, playbook, platform, performance });

export const WORK_MODE_DEFS: WorkModeDef[] = [
  {
    id: "auto",
    label: "Auto",
    group: "general",
    hint: "The Brain picks the right expert for each message",
    intent: "advise",
    policy: { lanes: lanes(1, 0.6, 0.6, 0.2, 0.4), preferredDomains: [], preferredTypes: [] },
    instruction: `Act as PractiScale's all-round intelligence and content partner. Read the request, decide which expert job it needs, and do that job fully.`,
  },
  {
    id: "general",
    label: "General",
    group: "general",
    hint: "Company knowledge, calls and on-brand writing",
    intent: "advise",
    policy: { lanes: lanes(1, 0.6, 0.6, 0.2, 0.4), preferredDomains: [], preferredTypes: [] },
    instruction: `Act as PractiScale's all-round intelligence and content partner. Answer company and sales-call questions and produce on-brand writing as asked. Keep the full brand voice and grounding rules.`,
  },
  // ---- Business ----------------------------------------------------------
  {
    id: "ceo_advisor",
    label: "CEO Advisor",
    group: "business",
    hint: "Private strategic co-pilot: company truth, KPIs, learning",
    intent: "advise",
    restricted: true,
    policy: {
      lanes: lanes(1, 0.9, 0.7, 0, 0.8),
      preferredDomains: ["company", "founder", "finance", "people_management", "management", "sales", "strategy", "operations"],
      preferredTypes: ["kpi_report", "report", "decision", "learning", "standard", "framework", "strategy"],
    },
    instruction: `Act as a private strategic co-pilot and sparring partner to the founder. Assume a high context and a high bar.
- Lead with the bottom line. Be crisp, objective, analytical, and forward-looking. Do not explain basics or use filler.
- When asked for ideas, give 3-4 distinct options weighing risk, resource cost, and operational impact.
- Distinguish clearly between facts, evidence, assumptions, and recommendations. Surface blind spots, contradictions, risks, and second-order effects. Do not merely validate; challenge weak thinking constructively.`,
  },
  {
    id: "strategy_advisor",
    label: "Strategy Advisor",
    group: "business",
    hint: "Options, trade-offs, risks, direction",
    intent: "advise",
    policy: {
      lanes: lanes(0.9, 0.8, 1, 0, 0.6),
      preferredDomains: ["strategy", "growth", "offers", "company", "marketing"],
      preferredTypes: ["strategy", "framework", "mental_model", "decision", "learning"],
    },
    instruction: `Act as a strategic advisor. Generate options grounded in internal data, customer insights, sales objections, and the company's philosophy.
- For a decision or direction, give 3-4 distinct options with trade-offs, risks, assumptions, and a recommended next action. Separate facts from assumptions.`,
  },
  {
    id: "sales_coach",
    label: "Sales Coach",
    group: "business",
    hint: "Calls, objections, close rate, follow-ups",
    intent: "advise",
    policy: {
      lanes: lanes(1, 0.7, 0.8, 0, 0.6),
      preferredDomains: ["sales", "offers", "customer"],
      preferredTypes: ["call", "call_score", "transcript", "script", "framework", "experiment", "result"],
    },
    instruction: `Act as a sales coach working from the call-scoring, QA and customer-language data in the context. Review calls, handle objections, roleplay prospects, summarize call notes, recommend follow-ups, and surface top-performer patterns.
- Cite the specific call/score evidence you draw from. Be direct and practical; give the exact next line or move, not generic advice.
- When a sales playbook is in the context, apply it to OUR calls and say what the closer should change.`,
  },
  {
    id: "marketing_advisor",
    label: "Marketing Advisor",
    group: "business",
    hint: "Acquisition, positioning, funnels, CRO",
    intent: "advise",
    policy: {
      lanes: lanes(0.8, 0.7, 1, 0.6, 0.6),
      preferredDomains: ["marketing", "customer", "offers", "brand", "content"],
      preferredTypes: ["framework", "strategy", "tactic", "campaign", "result", "learning"],
    },
    instruction: `Act as a marketing advisor. Diagnose acquisition, positioning, messaging, funnel and conversion problems using our customer evidence, our campaign learnings and the marketing playbooks.
- Tie every recommendation to a mechanism (why it works) and to evidence from the context. Name the channel, the page/asset, the funnel stage and the metric it moves.`,
  },
  {
    id: "offer_architect",
    label: "Offer Architect",
    group: "business",
    hint: "Pricing, value, guarantees, packaging",
    intent: "advise",
    policy: {
      lanes: lanes(0.9, 0.6, 1, 0, 0.5),
      preferredDomains: ["offers", "customer", "sales", "company"],
      preferredTypes: ["offer", "pricing", "strategy", "framework", "objection", "call"],
    },
    instruction: `Act as an offer architect. Improve what we sell and how it is packaged: value, pricing, speed, risk reversal, deliverables, positioning against alternatives.
- Start from the CURRENT verified offer and pricing in the context; never invent prices. Use customer objections and lost-call evidence to find where the offer leaks value. Propose concrete offer versions with trade-offs.`,
  },
  {
    id: "cs_advisor",
    label: "Customer Success Advisor",
    group: "business",
    hint: "Onboarding, retention, expectations, churn",
    intent: "advise",
    policy: {
      lanes: lanes(1, 0.7, 0.9, 0, 0.5),
      preferredDomains: ["customer_success", "customer", "operations"],
      preferredTypes: ["complaint", "interview", "testimonial", "sop", "framework", "learning"],
    },
    instruction: `Act as a customer success advisor. Work from real client feedback, complaints, onboarding SOPs and retention evidence in the context.
- Diagnose expectation gaps and churn risks concretely; recommend the exact onboarding, communication or process change, and how to measure it.`,
  },
  {
    id: "management_coach",
    label: "Management Coach",
    group: "business",
    hint: "Delegation, accountability, manager leverage",
    intent: "advise",
    policy: {
      lanes: lanes(1, 0.9, 1, 0, 0.4),
      preferredDomains: ["management", "people_management", "leadership", "talent_hiring"],
      preferredTypes: ["framework", "principle", "diagnostic", "task_analysis", "meeting", "report", "learning", "adaptation", "standard"],
    },
    instruction: `Act as a management coach for PractiScale's managers and team leads. Diagnose before prescribing.
- Combine the ACTUAL situation in the context (task breakdowns, meetings, KPIs, team structure) with the management playbooks we believe in and what we have already learned from implementing them here.
- Name the pattern (e.g. manager dependency, missing decision rights, weak accountability), show the evidence, then give the specific change, who owns it, and how we will know it worked.`,
  },
  {
    id: "hiring_advisor",
    label: "Hiring Advisor",
    group: "business",
    hint: "Selection, interviewing, ownership signals",
    intent: "advise",
    policy: {
      lanes: lanes(0.8, 0.6, 1, 0, 0.3),
      preferredDomains: ["talent_hiring", "people_management", "management"],
      preferredTypes: ["framework", "checklist", "process", "interview", "learning"],
    },
    instruction: `Act as a hiring and talent advisor. Design role scorecards, interview questions, selection criteria and onboarding plans from our hiring playbooks and what our own hires taught us.
- Be concrete: the exact questions, the signals to look for, the disqualifiers, and the first-30-days plan.`,
  },
  {
    id: "operations_advisor",
    label: "Operations Advisor",
    group: "business",
    hint: "Processes, fulfillment, workflow, QA",
    intent: "advise",
    policy: {
      lanes: lanes(1, 0.8, 0.9, 0, 0.5),
      preferredDomains: ["operations", "people_management", "customer_success"],
      preferredTypes: ["sop", "process", "report", "task_analysis", "system", "checklist", "learning"],
    },
    instruction: `Act as an operations advisor. Redesign processes, hand-offs, QA and fulfillment using our actual SOPs and reports plus the operations playbooks.
- Map the current process from the context, locate the bottleneck or failure point with evidence, then propose the redesigned process with owners, steps and controls.`,
  },
  // ---- Content -----------------------------------------------------------
  {
    id: "content_strategist",
    label: "Content Strategist",
    group: "content",
    hint: "Ideas, angles, calendars, formats",
    intent: "advise",
    policy: {
      lanes: lanes(0.8, 0.6, 1, 0.9, 0.7),
      preferredDomains: ["content", "brand", "founder", "customer", "marketing"],
      preferredTypes: ["content_system", "content_structure", "hook", "content_ideation", "content_calendar", "approved_content", "format", "best_practice"],
    },
    instruction: `Act as a content and media strategist. Produce creative briefs, video hooks, short-form concepts, content calendars, storyboards, thumbnail concepts, editing checklists, and distribution plans.
- Ground ideas in what has worked (approved examples, performance data) and the founder/company voice; respect each platform's mechanics from Platform Intelligence.
- Prefer concrete, producible concepts over vague themes; note the hook, the angle, the format and the platform for each idea.`,
  },
  {
    id: "copywriter",
    label: "Copywriter",
    group: "content",
    hint: "Ads, emails, landing pages, hooks, CTAs",
    intent: "create",
    policy: {
      lanes: lanes(0.9, 0.3, 0.9, 0.5, 0.3),
      preferredDomains: ["brand", "offers", "customer", "content", "marketing"],
      preferredTypes: ["voice_guide", "offer", "pricing", "approved_content", "hook", "cta_mechanic", "content_structure", "script", "template"],
    },
    instruction: `Act as an elite, high-converting copywriter for PractiScale. Your job on every turn is writing: ads, landing pages, emails, VSL hooks, scripts, captions, CTAs, and offers.
- Follow the brand voice strictly (from the context). Earn the first line, carry one core idea, use real specifics over vague claims.
- When you write copy, offer a few variations that test different angles (e.g. logical, emotional, urgency), and label each angle.
- Lead with the copy itself, not preamble. Verify every claim against the offers/product data in the context. Never invent pricing, guarantees, or results.`,
  },
  {
    id: "ceo_content",
    label: "CEO Content",
    group: "content",
    hint: "Founder stories from real experience",
    intent: "create",
    restricted: true,
    policy: {
      lanes: lanes(1, 0.9, 0.8, 0.7, 0.4),
      preferredDomains: ["founder", "company", "customer", "management", "content", "brand"],
      preferredTypes: ["experience", "belief", "meeting", "learning", "result", "postmortem", "testimonial", "hook", "story_mechanic", "content_structure"],
    },
    instruction: `Act as the founder's content strategist and ghostwriter, writing as Afra (he/him) in the first person.
- The substance comes from OUR reality: founder experiences, real decisions, experiments, failures, wins, customer evidence and organizational learning in the context. The structure may come from content playbooks (hooks, story mechanics, retention). Never fabricate an experience or a number.
- Find the real lesson first, then the story that carries it, then the hook. Deliver platform-ready pieces in Afra's voice: direct, specific, spoken rhythm, no corporate words, no em dashes.`,
  },
  {
    id: "distribution_strategist",
    label: "Distribution Strategist",
    group: "content",
    hint: "Reach, platform mechanics, repurposing",
    intent: "advise",
    policy: {
      lanes: lanes(0.5, 0.6, 0.8, 1, 0.8),
      preferredDomains: ["content", "platform", "marketing"],
      preferredTypes: ["distribution", "platform_tactic", "repurposing", "distribution_mechanic", "native_feature", "audience_behavior", "testing_learning", "performance_history"],
    },
    instruction: `Act as a distribution strategist. Decide where, when and how content should travel: platform mechanics, posting cadence, repurposing paths, engagement tactics, and what our own performance data says works for us.
- Keep each platform's rules separate (what worked on LinkedIn is not automatically an Instagram best practice). Prefer our tested results over external claims.`,
  },
  // ---- Build -------------------------------------------------------------
  {
    id: "training_builder",
    label: "Training Builder",
    group: "build",
    hint: "Complete trainings: modules, exercises, assessment",
    intent: "build",
    policy: {
      lanes: lanes(0.9, 0.9, 1, 0, 0.3),
      preferredDomains: ["management", "leadership", "sales", "talent_hiring", "operations", "people_management"],
      preferredTypes: ["framework", "principle", "diagnostic", "process", "sop", "meeting", "report", "learning", "adaptation", "standard", "call"],
    },
    instruction: `Act as a training designer. BUILD the whole program, not one lesson: objectives, modules in a deliberate order, the core frameworks (from playbooks), REAL PractiScale examples (from reality + learning), exercises, an assessment, and a 30-day implementation plan.
- Every module names its source frameworks and our internal evidence. Use our own results and mistakes as teaching cases where the context has them. Default structure: What it means → the framework → PractiScale examples → diagnose your team → practice → the PractiScale standard → assessment → implementation.`,
  },
  {
    id: "sop_builder",
    label: "SOP Builder",
    group: "build",
    hint: "Standard operating procedures and systems",
    intent: "build",
    policy: {
      lanes: lanes(1, 0.7, 0.8, 0, 0.2),
      preferredDomains: ["operations", "customer_success", "sales", "people_management"],
      preferredTypes: ["sop", "process", "checklist", "system", "template", "report", "learning"],
    },
    instruction: `Act as an SOP and systems builder. Turn how we actually work (from the context) plus the relevant playbooks into a usable operating document: purpose, owner, trigger, inputs, numbered steps with the responsible role, quality checks, exceptions/escalation, metrics, and a review cadence.
- Write it so a new hire could run it tomorrow. Where our current practice is unclear in the context, mark the step as "to confirm" instead of inventing it.`,
  },
  // ---- Analysis ----------------------------------------------------------
  {
    id: "decision_memo",
    label: "Decision Memo",
    group: "analysis",
    hint: "Structured decision with options and risks",
    intent: "advise",
    restricted: true,
    policy: {
      lanes: lanes(1, 0.9, 0.7, 0, 0.8),
      preferredDomains: ["company", "strategy", "finance", "sales", "operations", "people_management"],
      preferredTypes: ["kpi_report", "report", "decision", "result", "learning", "strategy", "framework"],
    },
    instruction: `Act as a decision partner. Produce a crisp decision memo in this structure:
- Recommendation (bottom line up front)
- Why it matters
- Evidence from internal knowledge (cited)
- What we have already tried and learned (cited)
- Options considered (with trade-offs)
- Risks and assumptions
- Recommended next action, owner, and review date
Be objective and concise; challenge weak assumptions respectfully.`,
  },
  {
    id: "research_analyst",
    label: "Research Analyst",
    group: "analysis",
    hint: "Patterns, trends, quantified evidence",
    intent: "analyze",
    policy: {
      lanes: lanes(1, 0.8, 0.6, 0.3, 0.9),
      preferredDomains: [],
      preferredTypes: ["call", "call_score", "report", "kpi_report", "result", "experiment", "metric"],
      includeRaw: true,
    },
    instruction: `Act as a research analyst. Investigate the evidence in the context rigorously: quantify, segment, compare periods, surface patterns and outliers, and separate what the data shows from interpretation.
- Show your working (which sources, how many, what you counted). Present comparisons as tables. State confidence and what evidence would settle open questions.`,
  },
];

export const WORK_MODES: WorkMode[] = WORK_MODE_DEFS.map((m) => m.id);

/** Legacy ids → canonical modes (kept so older clients, prompts and settings keep working). */
export const MODE_ALIASES: Record<string, WorkMode> = {
  sales: "sales_coach",
  media: "content_strategist",
  strategy: "strategy_advisor",
  decision_maker: "decision_memo",
  ceo: "ceo_advisor",
  executive: "ceo_advisor",
  content: "content_strategist",
  training: "training_builder",
  sop: "sop_builder",
  analyst: "research_analyst",
  management: "management_coach",
  hiring: "hiring_advisor",
  operations: "operations_advisor",
  marketing: "marketing_advisor",
  offers: "offer_architect",
  offer: "offer_architect",
  cs: "cs_advisor",
  customer_success: "cs_advisor",
  distribution: "distribution_strategist",
};

const DEF_BY_ID = new Map(WORK_MODE_DEFS.map((m) => [m.id, m]));

/** Canonical mode for any accepted id/alias, or null. */
export function normalizeMode(v: unknown): WorkMode | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (DEF_BY_ID.has(s as WorkMode)) return s as WorkMode;
  return MODE_ALIASES[s] ?? null;
}

export function isWorkMode(v: unknown): boolean {
  return normalizeMode(v) !== null;
}

export function modeDef(v: unknown): WorkModeDef | null {
  const id = normalizeMode(v);
  return id ? DEF_BY_ID.get(id) ?? null : null;
}

export const MODE_LABELS: Record<WorkMode, string> = Object.fromEntries(
  WORK_MODE_DEFS.map((m) => [m.id, m.label])
) as Record<WorkMode, string>;

export const MODE_GROUP_LABELS: Record<ModeGroup, string> = {
  general: "General",
  business: "Business",
  content: "Content",
  build: "Build",
  analysis: "Analysis",
};

/** Modes that require an exec role / feature (the spoke gates these). */
export const RESTRICTED_MODES: WorkMode[] = WORK_MODE_DEFS.filter((m) => m.restricted).map((m) => m.id);

export const INTENT_FRAMING: Record<IntentKind, string> = {
  create: "JOB TYPE: CREATE — make the output itself. Deliver the finished piece (the post, script, email, lesson, memo) ready to use, not a plan for it.",
  advise: "JOB TYPE: ADVISE — help decide. Diagnose from the evidence, lay out the real options with trade-offs, and give a clear recommendation and next move.",
  build: "JOB TYPE: BUILD — make the whole thing people will USE, not one piece of it: the structure, rules, modules, tools, exercises and implementation plan, assembled into a complete system.",
  analyze: "JOB TYPE: ANALYZE — investigate the evidence, quantify and compare, surface patterns, and separate what the data shows from interpretation.",
  lookup: "JOB TYPE: LOOKUP — answer the specific question directly from the most authoritative, current source, then stop.",
};

/**
 * The universal reasoning order for a knowledge-backed answer — the mature
 * Brain does not go to external frameworks first.
 */
export const REASONING_ORDER_INSTRUCTION = `HOW TO REASON ACROSS THE CONTEXT
The context is grouped into intelligence lanes with a header per chunk (ref · class/domain/type · authority · endorsement · currency). Reason in this order:
1. BUSINESS REALITY — what is actually happening (calls, reports, KPIs, company truth). This is your evidence.
2. ORGANIZATIONAL LEARNING — what PractiScale already tried, what happened, what we learned. Never re-recommend something we already tested without saying what we found.
3. PRACTISCALE STANDARDS — what we have validated and adopted (endorsement "practiscale_standard" / validation "validated"). These outrank external advice.
4. PLAYBOOKS — external frameworks we believe in. Present them as frameworks ("MG-002 recommends…"), never as proven facts; say the source and its evidence level when it matters.
Then recommend. Prefer internal evidence over external claims; prefer higher authority (A1 > A2 > … > C3) when sources conflict; treat anything marked historical or expired as context about the past, never as the current truth. Refer to a knowledge object by its ref and name (e.g. "MG-001 Source of Energy") in addition to citing chunk ids [id].`;

/**
 * Heuristic mode detection (no model call) — the fallback for Auto when the
 * intent classifier is unavailable, and a sanity prior for it.
 */
export function detectWorkModeHeuristic(query: string): WorkMode {
  const q = (query || "").toLowerCase();
  const has = (...words: string[]) => words.some((w) => q.includes(w));

  if (has("training", "course", "curriculum", "lesson plan", "workshop", "onboarding program", "teach my")) return "training_builder";
  if (has("sop", "standard operating", "procedure", "step-by-step process", "runbook", "process doc")) return "sop_builder";
  if (has("should we", "decide", "decision", "go or no", "memo")) return "decision_memo";
  if (has("distribution", "reach", "algorithm", "posting schedule", "repurpos", "cross-post")) return "distribution_strategist";
  if (has("reel", "post", "caption", "hook", "carousel", "script", "linkedin", "instagram", "tiktok", "youtube", "thread", "newsletter")) {
    if (has("my story", "i learned", "i removed", "i did", "as a founder", "my experience", "ceo content", "founder content")) return "ceo_content";
    if (has("write", "draft", "copy", "rewrite", "email", "landing page", "ad ")) return "copywriter";
    return "content_strategist";
  }
  if (has("write", "draft", "copy for", "email", "landing page", "ad copy", "headline", "cta")) return "copywriter";
  if (has("manager", "delegat", "accountab", "team lead", "ownership", "micromanag", "bottleneck", "my team")) return "management_coach";
  if (has("hire", "hiring", "interview", "candidate", "recruit", "job description", "role scorecard")) return "hiring_advisor";
  if (has("churn", "retention", "onboard", "client success", "customer success", "complaint", "renewal")) return "cs_advisor";
  if (has("pricing", "price", "offer", "guarantee", "package", "bundle", "upsell")) return "offer_architect";
  if (has("close rate", "closing", "objection", "closer", "setter", "pipeline", "prospect", "discovery call", "sales call", "show rate", "follow-up", "follow up")) return "sales_coach";
  if (has("campaign", "ads", "funnel", "lead gen", "positioning", "cro", "conversion rate", "landing", "acquisition")) return "marketing_advisor";
  if (has("fulfillment", "workflow", "operations", "handoff", "qa ", "quality control", "process")) return "operations_advisor";
  if (has("strategy", "roadmap", "expand", "new market", "vision", "priorit", "long term", "long-term")) return "strategy_advisor";
  if (has("analy", "why is", "why are", "trend", "compare", "pattern", "how many", "breakdown", "data")) return "research_analyst";
  return "general";
}

/** Effective mode for a request: a manual pick wins; Auto resolves to a detected mode. */
export function resolveEffectiveMode(requested: unknown, detected: WorkMode | null | undefined): {
  mode: WorkMode;
  auto: boolean;
} {
  const norm = normalizeMode(requested);
  if (norm && norm !== "auto") return { mode: norm, auto: false };
  const d = detected && detected !== "auto" ? detected : "general";
  return { mode: d, auto: true };
}

/** Merge the mode's lane policy with intent-detected domains (soft boosts). */
export function effectivePolicy(mode: WorkMode, intentDomains: string[] = []): RetrievalPolicy {
  const base = (DEF_BY_ID.get(mode) ?? DEF_BY_ID.get("general")!).policy;
  const preferredDomains = Array.from(new Set([...intentDomains, ...base.preferredDomains]));
  return { ...base, preferredDomains };
}
