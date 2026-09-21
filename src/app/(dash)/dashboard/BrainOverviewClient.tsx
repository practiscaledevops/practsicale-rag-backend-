"use client";

// The AI Brain overview — a CEO-friendly, read-at-a-glance page: hero stats,
// how the Brain is organised / what it trusts / what it learned / how it is
// connected, fed and answering, a health checklist, and a plain-English
// explainer per component. The landing page server-renders the first payload
// (`initial`, from getBrainOverview) so nothing loads on first paint; Refresh
// re-fetches /api/admin/knowledge/overview client-side.

import * as React from "react";
import Link from "next/link";
import { RefreshCw, ArrowRight, CheckCircle2, AlertTriangle, ChevronDown } from "lucide-react";
import { C, Chip, KBtn, Panel, ErrorNote, Skeleton, StatBox, fmtDate, humanize, classTone, api, type Tone } from "@/components/ui/brain-ui";
import { INTELLIGENCE_CLASSES, FOUNDER_ENDORSEMENTS, IMPLEMENTATION_STATUSES, INTERNAL_VALIDATIONS, LEARNING_STATUSES, type IntelligenceClass } from "@/lib/intelligence-taxonomy";
import type { BrainOverview, Labelled, HealthRow } from "@/lib/brain-overview";

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const n = (v: number | null | undefined): string => (v === null || v === undefined ? "—" : v.toLocaleString());
const pct = (v: number | null | undefined): string => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);
const ms = (v: number | null | undefined): string => (v === null || v === undefined ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);

function relTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "never";
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const TONE_FG: Record<Tone, string> = { green: C.green, mint: C.restricted, amber: C.amber, red: C.red, info: C.info, violet: C.violet, muted: C.muted };

/** Where each class is managed (the explorer deep-links on ?class=). */
const CLASS_HREF: Record<string, string> = {
  business_reality: "/dashboard/knowledge?class=business_reality",
  playbook: "/dashboard/knowledge?class=playbook",
  organizational_learning: "/dashboard/learning",
  platform_intelligence: "/dashboard/knowledge?class=platform_intelligence",
  performance_memory: "/dashboard/performance",
  raw_archive: "/dashboard/documents",
};

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function Manage({ href, label = "Manage" }: { href: string; label?: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-xs font-medium hover:underline" style={{ color: C.green }}>
      {label} <ArrowRight size={12} aria-hidden />
    </Link>
  );
}

function Section({ title, subtitle, action, children, className }: { title: string; subtitle?: string; action?: { href: string; label: string }; children: React.ReactNode; className?: string }) {
  return (
    <Panel title={title} subtitle={subtitle} actions={action ? <Manage href={action.href} label={action.label} /> : undefined} className={className}>
      {children}
    </Panel>
  );
}

/** Compact stat inside a section. */
function Tile({ label, value, hint, tone = "green" }: { label: string; value: React.ReactNode; hint?: string; tone?: Tone }) {
  return (
    <div className="rounded-lg px-3 py-2.5" style={{ background: C.raised, border: `1px solid ${C.border}` }}>
      <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: C.muted }}>{label}</p>
      <p className="mt-0.5 text-xl font-semibold tabular-nums" style={{ color: TONE_FG[tone] }}>{value}</p>
      {hint && <p className="text-[11px]" style={{ color: C.muted }}>{hint}</p>}
    </div>
  );
}

/** Horizontal bars (plain divs) — label, count and a bar relative to the largest. */
function BarList({ items, tone = "green", empty = "Nothing yet", max }: { items: Labelled[]; tone?: Tone; empty?: string; max?: number }) {
  if (!items.length || items.every((i) => i.count === 0)) return <p className="py-2 text-xs" style={{ color: C.muted }}>{empty}</p>;
  const top = max ?? Math.max(1, ...items.map((i) => i.count));
  return (
    <ul className="space-y-1.5">
      {items.map((i) => (
        <li key={i.id}>
          <div className="mb-0.5 flex items-center justify-between gap-2 text-xs">
            <span className="truncate" style={{ color: C.text }} title={i.label}>{i.label}</span>
            <span className="shrink-0 tabular-nums font-medium" style={{ color: TONE_FG[tone] }}>{i.count.toLocaleString()}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: C.bg }}>
            <div className="h-full rounded-full" style={{ width: `${Math.max(i.count > 0 ? 3 : 0, (i.count / top) * 100)}%`, background: TONE_FG[tone] }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function SubHead({ children }: { children: React.ReactNode }) {
  return <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: C.muted }}>{children}</p>;
}

function Unavailable({ what }: { what: string }) {
  return <p className="rounded-lg px-3 py-3 text-xs" style={{ color: C.amber, background: "rgba(243,182,97,0.08)", border: "1px solid rgba(243,182,97,0.25)" }}>{what} could not be read just now. If this persists, check that the Brain migrations are applied (0014 query log, 0017 Operating Intelligence) and that the database is reachable, then refresh.</p>;
}

function SkeletonPage() {
  return (
    <div className="space-y-4" aria-busy>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-xl px-4 py-3" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-3 h-7 w-16" />
            <Skeleton className="mt-2 h-3 w-28" />
          </div>
        ))}
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-xl p-4" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
          <Skeleton className="h-4 w-48" />
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, j) => (
              <div key={j} className="space-y-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The explainer (plain English per component, grounded in docs/10)
// ---------------------------------------------------------------------------

interface ExplainCard {
  id: string;
  title: string;
  tone: Tone;
  what: string;
  holds: string;
  uses: string;
  href: string;
  hrefLabel: string;
}

function explainCards(d: BrainOverview): ExplainCard[] {
  const o = d.objects;
  const cls = (id: string) => n(o?.byClass[id as IntelligenceClass]);
  const lane = (id: string) => n(d.lanes?.chunks.byClass[id as IntelligenceClass]);
  const aLevel = o ? o.authority.filter((a) => a.id.startsWith("A")).reduce((s, a) => s + a.count, 0) : null;
  const headline = d.performance?.headline.map((h) => `${h.label.toLowerCase()} ${h.value}${h.unit ?? ""}`).join(", ");
  const topMode = d.retrieval?.byMode[0];
  return [
    {
      id: "business_reality",
      title: "Business Reality",
      tone: "green",
      what: "The record of what is actually true at PractiScale: company facts, pricing and offers, the founder's current positions, customer feedback, scored sales calls, SOPs and proof. It is the most trusted class — when two sources disagree, reality wins.",
      holds: `${cls("business_reality")} objects · ${lane("business_reality")} searchable chunks in this lane.`,
      uses: "Searched first for almost every question. The reasoning order is reality → learning → standards → playbooks, so an outside framework can never overrule a company fact.",
      href: CLASS_HREF.business_reality,
      hrefLabel: "Knowledge objects",
    },
    {
      id: "playbook",
      title: "Playbooks",
      tone: "info",
      what: "Curated frameworks, principles, tactics, scripts and templates from experts, books, consultants and our own team. A playbook is an idea about what should work — not yet proof that it did for us.",
      holds: `${cls("playbook")} objects · ${lane("playbook")} chunks · ${n(o?.endorsement.practiscale_standard)} are PractiScale Standards.`,
      uses: "Retrieved in its own lane; ranked by relevance first, then nudged by founder endorsement, internal validation and authority (approved PractiScale playbook > approved external > unverified claim).",
      href: CLASS_HREF.playbook,
      hrefLabel: "Knowledge objects",
    },
    {
      id: "organizational_learning",
      title: "Organizational Learning",
      tone: "violet",
      what: "The memory of what PractiScale decided, implemented, measured and learned — a chain of decision → implementation → experiment → result → learning → adaptation → standard. Mostly captured from real work and always confirmed by a human.",
      holds: `${n(d.learning?.total)} records · ${n(d.learning?.open)} still open · ${n(d.learning?.byStatus.validated)} validated.`,
      uses: "Ranks above playbooks: 'what worked for us' outranks 'what an expert says should work'. A learning that validates a playbook can promote it to a PractiScale Standard.",
      href: "/dashboard/learning",
      hrefLabel: "Learning Lab",
    },
    {
      id: "platform_intelligence",
      title: "Platform Intelligence",
      tone: "mint",
      what: "How each platform works — LinkedIn, Instagram, YouTube, email and the rest: formats, audience behaviour, hooks, distribution mechanics, native features and constraints, plus what we tested there.",
      holds: `${cls("platform_intelligence")} objects · ${lane("platform_intelligence")} chunks.`,
      uses: "Weighted up by the content experts (Content Strategist, Copywriter, Distribution) so content advice is specific to the platform it will be published on.",
      href: CLASS_HREF.platform_intelligence,
      hrefLabel: "Knowledge objects",
    },
    {
      id: "performance_memory",
      title: "Performance Memory",
      tone: "amber",
      what: "The numbers, kept as structured data instead of prose: close rate, call scores, campaign results and experiment outcomes, per period and per consultant, segment or campaign. Rebuilt automatically from every call-scoring sync.",
      holds: `${n(d.performance?.metrics)} metrics${headline ? ` · ${headline}` : ""}${d.performance?.latestPeriod ? ` · latest period ${fmtDate(d.performance.latestPeriod)}` : ""}.`,
      uses: "When a question needs numbers, the matching metrics are injected into the answer as a verified table next to the text context, so figures are quoted rather than guessed.",
      href: "/dashboard/performance",
      hrefLabel: "Performance memory",
    },
    {
      id: "raw_archive",
      title: "Raw Archive",
      tone: "muted",
      what: "The original, unprocessed source material behind compiled knowledge, kept for provenance and history. Also everything ingested the old way — uploads, transcripts, call scores — as documents.",
      holds: `${n(d.lanes?.documents.total)} documents · ${lane("raw_archive")} chunks in the raw lane.`,
      uses: "Low authority. Never presented as current truth and only searched when an analyst explicitly asks for original sources.",
      href: "/dashboard/documents",
      hrefLabel: "Documents",
    },
    {
      id: "taxonomy",
      title: "Taxonomy",
      tone: "green",
      what: "The one classification system for everything: CLASS → DOMAIN → TYPE → SUBTYPE plus open tags. A domain says what a piece of knowledge is about (Sales, Management, Content…), never where it came from.",
      holds: `${n(d.taxonomy?.approved)} approved custom values · ${n(d.taxonomy?.pending)} AI proposals waiting for approval.`,
      uses: "The intent classifier maps every question to domains and types, and the orchestrator boosts objects that fit — a soft nudge, never a hard filter, so nothing relevant is hidden.",
      href: "/dashboard/taxonomy",
      hrefLabel: "Taxonomy",
    },
    {
      id: "entities",
      title: "Entities",
      tone: "mint",
      what: "The WHO and WHAT inside the knowledge: people, departments, clients, offers, campaigns, platforms, frameworks and KPIs. Extracted automatically when knowledge is compiled and when call scores are rebuilt.",
      holds: `${n(d.graph?.entities.total)} entities${d.graph?.entities.byKind[0] ? ` · most common: ${d.graph.entities.byKind[0].label.toLowerCase()} (${d.graph.entities.byKind[0].count})` : ""}.`,
      uses: "When a question names a consultant, client or offer, the Brain recognises the entity and pulls the objects that mention the same one.",
      href: "/dashboard/entities",
      hrefLabel: "Entities",
    },
    {
      id: "relationships",
      title: "Relationships",
      tone: "info",
      what: "Links between objects — complements, contradicts, implemented in, validated by, used the playbook, adapted into. The AI suggests them; a human confirms or rejects.",
      holds: `${n(d.graph?.relationships.confirmed)} confirmed · ${n(d.graph?.relationships.suggested)} suggested and waiting for review.`,
      uses: "After retrieval the Brain takes one hop over confirmed links, so an answer about a playbook can bring in the learning that validated it — or the object that contradicts it.",
      href: "/dashboard/relationships",
      hrefLabel: "Relationships",
    },
    {
      id: "authority",
      title: "Authority & currency",
      tone: "amber",
      what: "Authority (A1 verified company truth … C3 archive) says what to believe when sources conflict. The temporal fields (effective from / until, last verified) say whether something is still current.",
      holds: `${n(aLevel)} objects at A-level trust · ${n(o?.currency.current)} current · ${n(o?.currency.expired)} expired · ${n(o?.currency.historical)} historical · ${n(o?.needsVerification.count)} need re-verification.`,
      uses: "Both nudge ranking, and every piece of context is labelled with its authority and currency so the model knows what it is reading. Expired or historical objects are never presented as current truth.",
      href: "/dashboard/knowledge?status=historical",
      hrefLabel: "Knowledge objects",
    },
    {
      id: "provenance",
      title: "Provenance",
      tone: "muted",
      what: "Who said it, where, when and what they claimed — kept separately from what has been proven. Every object carries its sources and the claims made by them.",
      holds: `${n(o?.total)} objects carry provenance · ${n(o?.endorsement.approved)} approved and ${n(o?.endorsement.practiscale_standard)} standardised by the founder · ${n(o?.validation.validated)} validated internally.`,
      uses: "A guard: an outside expert or social post can never establish Company Truth without an explicit confirmation. Source claims are listed apart from validated facts in every compiled object.",
      href: "/dashboard/knowledge",
      hrefLabel: "Knowledge objects",
    },
    {
      id: "work_modes",
      title: "Work modes & Auto",
      tone: "green",
      what: "One Brain, many experts: CEO Advisor, Strategy, Sales Coach, Marketing, Offer Architect, Content Strategist, Copywriter, SOP Builder, Decision Memo and more. Each mode is a retrieval policy plus a reasoning style. Auto lets the Brain pick the expert.",
      holds: `${n(d.retrieval?.queries)} questions answered this week${topMode ? ` · busiest expert: ${topMode.label} (${topMode.count})` : ""} · Auto mode ${d.flags.autoWorkMode ? "on" : "off"}.`,
      uses: "The mode decides which lanes matter most and which domains are boosted, then frames the job as CREATE, ADVISE or BUILD.",
      href: "/dashboard/prompts",
      hrefLabel: "Prompts & modes",
    },
    {
      id: "compiler",
      title: "Knowledge Compiler & dedup",
      tone: "info",
      what: "How knowledge gets in: give the Brain information and its class, and it classifies, fits the taxonomy, checks for duplicates (new / enrich / duplicate / conflict), compiles a canonical page and stores it with entities and relationships. Every decision is logged.",
      holds: `${n(d.ingestion?.decisionsLast7d)} automatic decisions this week · last one ${relTime(d.ingestion?.lastDecisionAt)}${d.ingestion ? ` · 30-day dedup: ${d.ingestion.dedupLast30d.new} new, ${d.ingestion.dedupLast30d.enrich} enriched, ${d.ingestion.dedupLast30d.duplicate} duplicates, ${d.ingestion.dedupLast30d.conflict} conflicts` : ""}.`,
      uses: "A conflict creates both objects and links them as contradicting, so the disagreement is visible in answers instead of silently picking one side.",
      href: "/dashboard/knowledge/add",
      hrefLabel: "Add knowledge",
    },
    {
      id: "orchestrator",
      title: "Retrieval orchestrator",
      tone: "violet",
      what: "The part that answers. It understands the question (expert, job, domains, entities, whether numbers are needed), plans which lanes to search, searches them in parallel, nudges by fit and trust, expands over relationships, reranks, and hands the model lane-grouped context with identity headers.",
      holds: `${d.flags.orchestrator ? "Enabled" : "Off (classic pipeline)"} · grounded rate ${pct(d.retrieval?.groundedRate)} · ${n(d.retrieval?.refusals)} refusals this week · average answer ${ms(d.retrieval?.avgLatencyMs)}.`,
      uses: "Ground or refuse: the Brain answers only from what it retrieved and says so when the knowledge is not there.",
      href: "/dashboard/retrieval-policy",
      hrefLabel: "Retrieval policy",
    },
    {
      id: "learning_detection",
      title: "Learning detection",
      tone: "mint",
      what: "The Brain watches conversations for a decision, an implementation, a result or a lesson, and offers to save it as organizational learning. Nothing is believed until a person confirms it.",
      holds: `${d.flags.learningDetection ? "Enabled" : "Off"} · ${n(d.learning?.pendingFollowUps)} open learnings still missing evidence · ${n(d.learning?.suggestedEvidenceEdges)} suggested evidence links to review.`,
      uses: "Confirmed learning enters the lifecycle, links to the playbooks it used, and can promote them to PractiScale Standards.",
      href: "/dashboard/learning",
      hrefLabel: "Learning Lab",
    },
  ];
}

function Explainer({ d }: { d: BrainOverview }) {
  const cards = explainCards(d);
  return (
    <div className="grid gap-2 md:grid-cols-2">
      {cards.map((c) => (
        <details key={c.id} className="group rounded-lg" style={{ background: C.raised, border: `1px solid ${C.border}` }}>
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm font-medium [&::-webkit-details-marker]:hidden" style={{ color: C.text }}>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: TONE_FG[c.tone] }} aria-hidden />
            <span className="flex-1">{c.title}</span>
            <ChevronDown size={14} className="shrink-0 transition-transform group-open:rotate-180" style={{ color: C.muted }} aria-hidden />
          </summary>
          <div className="space-y-2 px-3 pb-3 text-xs" style={{ color: C.text, borderTop: `1px solid ${C.border}` }}>
            <p className="pt-2"><span className="font-semibold" style={{ color: C.muted }}>What it is · </span>{c.what}</p>
            <p><span className="font-semibold" style={{ color: C.muted }}>What it holds now · </span><span style={{ color: TONE_FG[c.tone] }}>{c.holds}</span></p>
            <p><span className="font-semibold" style={{ color: C.muted }}>How the Brain uses it · </span>{c.uses}</p>
            <Manage href={c.href} label={`Manage in ${c.hrefLabel}`} />
          </div>
        </details>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function Hero({ d }: { d: BrainOverview }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <StatBox label="Knowledge objects" value={n(d.objects?.total)} hint="compiled, classified pieces of intelligence" />
      <StatBox label="Learnings" value={n(d.learning?.total)} hint="decisions, experiments and results we recorded" tone="violet" />
      <StatBox label="Relationships" value={n(d.graph?.relationships.confirmed)} hint="confirmed links between objects" tone="info" />
      <StatBox label="Entities" value={n(d.graph?.entities.total)} hint="people, clients, offers, platforms it knows" tone="mint" />
      <StatBox label="Metrics" value={n(d.performance?.metrics)} hint="numbers in Performance Memory" tone="amber" />
      <StatBox label="Queries this week" value={n(d.retrieval?.queries)} hint="questions answered through the API" />
    </div>
  );
}

function ClassCard({ id, d }: { id: string; d: BrainOverview }) {
  const def = INTELLIGENCE_CLASSES.find((c) => c.id === id)!;
  const tone = classTone(id);
  const count = d.objects?.byClass[id as IntelligenceClass];
  const chunks = d.lanes?.chunks.byClass[id as IntelligenceClass];
  const domains = d.objects?.topDomainsByClass[id] ?? [];
  const isLearning = id === "organizational_learning";
  const isPerf = id === "performance_memory";
  return (
    <div className="flex flex-col rounded-xl p-4" style={{ background: C.raised, border: `1px solid ${C.border}` }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold" style={{ color: C.text }}>{def.label}</p>
          <p className="text-xs italic" style={{ color: C.muted }}>{def.question}</p>
        </div>
        <Chip tone={def.core ? tone : "muted"}>{def.core ? "Core" : "Supporting"}</Chip>
      </div>
      <p className="mt-3 text-3xl font-semibold tabular-nums" style={{ color: TONE_FG[tone] }}>{isLearning ? n(d.learning?.total ?? count) : isPerf ? n(d.performance?.metrics) : n(count)}</p>
      <p className="text-xs" style={{ color: C.muted }}>
        {isLearning ? "learning records" : isPerf ? "metrics" : "objects"} · {n(chunks)} chunks in this lane
        {isPerf && count ? ` · ${n(count)} snapshot objects` : ""}
      </p>
      <div className="mt-3 flex min-h-[22px] flex-wrap gap-1">
        {domains.length ? domains.map((x) => <Chip key={x.id} tone="muted">{x.label} · {x.count}</Chip>) : <span className="text-[11px]" style={{ color: C.muted }}>No domains yet</span>}
      </div>
      <div className="mt-auto pt-3"><Manage href={CLASS_HREF[id]} /></div>
    </div>
  );
}

function Organised({ d }: { d: BrainOverview }) {
  const raw = d.objects?.byClass.raw_archive;
  return (
    <Section title="How the Brain is organised" subtitle="Three core intelligence classes the team feeds, two supporting systems the Brain feeds itself." action={{ href: "/dashboard/knowledge", label: "All objects" }}>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {["business_reality", "playbook", "organizational_learning"].map((id) => <ClassCard key={id} id={id} d={d} />)}
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {["platform_intelligence", "performance_memory"].map((id) => <ClassCard key={id} id={id} d={d} />)}
      </div>
      <p className="mt-3 text-xs" style={{ color: C.muted }}>
        Plus the <span style={{ color: C.text }}>Raw Archive</span>: {n(d.lanes?.documents.total)} documents and {n(d.lanes?.chunks.byClass.raw_archive)} raw chunks{raw ? ` (${n(raw)} archive objects)` : ""} kept for provenance, searched only on request. {n(d.lanes?.chunks.embedded)} of {n(d.lanes?.chunks.total)} chunks are embedded and searchable.
        {d.objects?.capped ? " Distribution figures are sampled from the newest 5,000 objects." : ""}
      </p>
    </Section>
  );
}

function Trusts({ d }: { d: BrainOverview }) {
  const o = d.objects;
  if (!o) return <Section title="What the Brain trusts"><Unavailable what="Trust and governance" /></Section>;
  const endorse: Labelled[] = FOUNDER_ENDORSEMENTS.map((e) => ({ id: e.id, label: e.label, count: o.endorsement[e.id] }));
  const impl: Labelled[] = IMPLEMENTATION_STATUSES.map((s) => ({ id: s.id, label: s.label, count: o.implementation[s.id] ?? 0 }));
  const val: Labelled[] = INTERNAL_VALIDATIONS.map((s) => ({ id: s.id, label: s.label, count: o.validation[s.id] ?? 0 }));
  const authority: Labelled[] = o.authority.map((a) => ({ ...a, label: `${a.id} · ${a.label}` }));
  const total = Math.max(1, o.currency.current + o.currency.expired + o.currency.historical);
  return (
    <Section title="What the Brain trusts" subtitle="Authority says what wins when sources disagree; endorsement, implementation and validation say how proven it is; currency says whether it is still true." action={{ href: "/dashboard/knowledge", label: "Review governance" }}>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div>
          <SubHead>Authority ladder (A1 = most trusted)</SubHead>
          <BarList items={authority} tone="green" />
        </div>
        <div className="space-y-4">
          <div>
            <SubHead>Founder endorsement pipeline</SubHead>
            <div className="grid grid-cols-3 gap-2">
              {endorse.map((e, i) => (
                <Tile key={e.id} label={e.label} value={n(e.count)} tone={i === 2 ? "green" : i === 1 ? "mint" : "muted"} />
              ))}
            </div>
            <p className="mt-1 text-[11px]" style={{ color: C.muted }}>{n(o.endorsement.none)} objects have no endorsement yet.</p>
          </div>
          <div>
            <SubHead>Implementation</SubHead>
            <BarList items={impl} tone="info" />
          </div>
          <div>
            <SubHead>Internal validation</SubHead>
            <BarList items={val} tone="mint" />
          </div>
        </div>
        <div className="space-y-4">
          <div>
            <SubHead>Currency</SubHead>
            <div className="flex h-2.5 w-full overflow-hidden rounded-full" style={{ background: C.bg }} aria-hidden>
              <div style={{ width: `${(o.currency.current / total) * 100}%`, background: C.green }} />
              <div style={{ width: `${(o.currency.expired / total) * 100}%`, background: C.amber }} />
              <div style={{ width: `${(o.currency.historical / total) * 100}%`, background: C.muted }} />
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <Tile label="Current" value={n(o.currency.current)} tone="green" />
              <Tile label="Expired" value={n(o.currency.expired)} tone={o.currency.expired ? "amber" : "muted"} />
              <Tile label="Historical" value={n(o.currency.historical)} tone="muted" />
            </div>
          </div>
          <div>
            <SubHead>Needs re-verification ({n(o.needsVerification.count)})</SubHead>
            {o.needsVerification.count === 0 ? (
              <p className="text-xs" style={{ color: C.green }}>Everything was verified in the last 90 days.</p>
            ) : (
              <ul className="space-y-1">
                {o.needsVerification.examples.map((x) => (
                  <li key={x.ref} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate" style={{ color: C.text }}><span className="font-mono" style={{ color: C.amber }}>{x.ref}</span> {x.name}</span>
                    <span className="shrink-0" style={{ color: C.muted }}>{x.lastVerifiedAt ? fmtDate(x.lastVerifiedAt) : "never"}</span>
                  </li>
                ))}
                {o.needsVerification.count > o.needsVerification.examples.length && (
                  <li className="text-[11px]" style={{ color: C.muted }}>+ {n(o.needsVerification.count - o.needsVerification.examples.length)} more</li>
                )}
              </ul>
            )}
          </div>
        </div>
      </div>
    </Section>
  );
}

function Learned({ d }: { d: BrainOverview }) {
  const l = d.learning;
  if (!l) return <Section title="What we have learned"><Unavailable what="Organizational Learning" /></Section>;
  const statuses: Labelled[] = LEARNING_STATUSES.map((s) => ({ id: s.id, label: s.label, count: l.byStatus[s.id] ?? 0 })).filter((s) => s.count > 0);
  const experiments = l.funnel.find((f) => f.id === "experiment")?.count ?? 0;
  return (
    <Section title="What we have learned" subtitle="The lifecycle every learning walks: decision → implementation → experiment → result → learning → adaptation → PractiScale Standard." action={{ href: "/dashboard/learning", label: "Learning Lab" }}>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <SubHead>Lifecycle funnel</SubHead>
          <BarList items={l.funnel} tone="violet" empty="No learning recorded yet — save one from a chat or the Learning Lab." />
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Tile label="Open work" value={n(l.open)} hint="open · implementing · measuring" tone="violet" />
            <Tile label="Experiments" value={n(experiments)} hint="recorded so far" tone="violet" />
            <Tile label="Pending follow-ups" value={n(l.pendingFollowUps)} hint="open records missing evidence" tone={l.pendingFollowUps ? "amber" : "muted"} />
            <Tile label="Evidence to review" value={n(l.suggestedEvidenceEdges)} hint="AI-suggested evidence links" tone={l.suggestedEvidenceEdges ? "amber" : "muted"} />
          </div>
          <div>
            <SubHead>By status</SubHead>
            <div className="flex flex-wrap gap-1">
              {statuses.length ? statuses.map((s) => <Chip key={s.id} tone={s.id === "validated" ? "green" : s.id === "rejected" ? "red" : s.id === "archived" ? "muted" : "violet"}>{s.label} · {s.count}</Chip>) : <span className="text-xs" style={{ color: C.muted }}>—</span>}
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

function Connected({ d }: { d: BrainOverview }) {
  const g = d.graph;
  if (!g) return <Section title="How it is connected"><Unavailable what="The knowledge graph" /></Section>;
  return (
    <Section title="How it is connected" subtitle="Entities are the who and what; relationships are the links the Brain follows when it answers." action={{ href: "/dashboard/relationships", label: "Relationships" }}>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <SubHead>Entities by kind · {n(g.entities.total)} total</SubHead>
            <Manage href="/dashboard/entities" label="Entities" />
          </div>
          <BarList items={g.entities.byKind} tone="mint" empty="No entities extracted yet." />
        </div>
        <div>
          <div className="mb-2 grid grid-cols-3 gap-2">
            <Tile label="Confirmed" value={n(g.relationships.confirmed)} tone="green" />
            <Tile label="Suggested" value={n(g.relationships.suggested)} hint="waiting for review" tone={g.relationships.suggested ? "amber" : "muted"} />
            <Tile label="Rejected" value={n(g.relationships.rejected)} tone="muted" />
          </div>
          <SubHead>Relationships by type</SubHead>
          <BarList items={g.relationships.byType} tone="info" empty="No links yet — the compiler suggests them as knowledge is added." />
        </div>
      </div>
    </Section>
  );
}

function Fed({ d }: { d: BrainOverview }) {
  const ing = d.ingestion;
  const tax = d.taxonomy;
  const docs = d.lanes?.documents;
  const docItems: Labelled[] = docs ? Object.entries(docs.bySourceType).map(([id, count]) => ({ id, label: humanize(id), count })) : [];
  return (
    <Section title="How it is fed" subtitle="Every piece of knowledge passes through the compiler: classify → taxonomy → dedup → compile → persist. Every decision is logged." action={{ href: "/dashboard/knowledge/add", label: "Add knowledge" }}>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <SubHead>Decisions this week · {n(ing?.decisionsLast7d)}</SubHead>
            <Manage href="/dashboard/decisions" label="Log" />
          </div>
          {ing ? <BarList items={ing.byStage} tone="green" empty="No automatic decisions in the last 7 days." /> : <Unavailable what="The decision log" />}
          {ing && <p className="mt-2 text-[11px]" style={{ color: C.muted }}>Last decision {relTime(ing.lastDecisionAt)}.</p>}
        </div>
        <div>
          <SubHead>Dedup outcomes · last 30 days</SubHead>
          {ing ? (
            <div className="grid grid-cols-2 gap-2">
              <Tile label="New" value={n(ing.dedupLast30d.new)} tone="green" />
              <Tile label="Enriched" value={n(ing.dedupLast30d.enrich)} tone="mint" />
              <Tile label="Duplicates" value={n(ing.dedupLast30d.duplicate)} tone="muted" />
              <Tile label="Conflicts" value={n(ing.dedupLast30d.conflict)} tone={ing.dedupLast30d.conflict ? "amber" : "muted"} />
            </div>
          ) : (
            <Unavailable what="Dedup history" />
          )}
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <SubHead>Taxonomy proposals · {n(tax?.pending)} pending</SubHead>
            <Manage href="/dashboard/taxonomy" label="Taxonomy" />
          </div>
          {tax ? (
            tax.latestProposals.length ? (
              <ul className="space-y-1">
                {tax.latestProposals.map((p, i) => (
                  <li key={`${p.kind}-${p.value}-${i}`} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate" style={{ color: C.text }}><Chip tone="amber">{humanize(p.kind)}</Chip> {p.value}{p.domain ? <span style={{ color: C.muted }}> · {p.domain}{p.objectType ? `/${p.objectType}` : ""}</span> : null}</span>
                    <span className="shrink-0" style={{ color: C.muted }}>{relTime(p.createdAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs" style={{ color: C.green }}>Nothing waiting. {n(tax.approved)} approved custom values in use.</p>
            )
          ) : (
            <Unavailable what="The taxonomy queue" />
          )}
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <SubHead>Documents by source · {n(docs?.total)}</SubHead>
            <Manage href="/dashboard/uploads" label="Upload" />
          </div>
          <BarList items={docItems} tone="muted" empty="No documents yet." />
        </div>
      </div>
    </Section>
  );
}

function Answers({ d }: { d: BrainOverview }) {
  const r = d.retrieval;
  return (
    <Section title="How it answers" subtitle="Last 7 days through the public API. Auto mode picks the expert; ground-or-refuse keeps it honest." action={{ href: "/dashboard/quality", label: "Query intelligence" }}>
      {!r ? (
        <Unavailable what="Query logging" />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid grid-cols-2 gap-2">
            <Tile label="Queries" value={n(r.queries)} hint="this week" />
            <Tile label="Grounded rate" value={pct(r.groundedRate)} hint="answers backed by retrieved knowledge" tone={r.groundedRate === null ? "muted" : r.groundedRate >= 0.8 ? "green" : "amber"} />
            <Tile label="Refusals" value={n(r.refusals)} hint="said 'I don't know' instead of guessing" tone={r.refusals ? "amber" : "muted"} />
            <Tile label="Avg latency" value={ms(r.avgLatencyMs)} hint={r.answersWithLatency ? `${n(r.answersWithLatency)} answers measured` : "no answers measured"} tone="info" />
          </div>
          <div>
            <SubHead>Questions by expert (work mode)</SubHead>
            <BarList items={r.byMode} tone="green" empty="No questions this week." />
            <p className="mt-2 text-[11px]" style={{ color: C.muted }}>
              Orchestrator {d.flags.orchestrator ? "on" : "off"} · Auto mode {d.flags.autoWorkMode ? "on" : "off"} · relationship expansion {d.flags.relationshipExpansion ? "on" : "off"} · learning detection {d.flags.learningDetection ? "on" : "off"}.
            </p>
          </div>
        </div>
      )}
    </Section>
  );
}

function Health({ rows }: { rows: HealthRow[] }) {
  const warn = rows.filter((r) => r.status === "warn").length;
  return (
    <Section title="Brain health" subtitle={warn === 0 ? "Everything is green. Nothing needs your attention." : `${warn} item${warn === 1 ? "" : "s"} need attention.`}>
      <ul>
        {rows.map((r, i) => (
          <li key={r.id} className="flex items-start gap-3 py-2.5" style={i ? { borderTop: `1px solid ${C.border}` } : undefined}>
            {r.status === "ok" ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" style={{ color: C.green }} aria-label="OK" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" style={{ color: C.amber }} aria-label="Needs attention" />}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium" style={{ color: C.text }}>{r.label}</p>
              <p className="text-xs" style={{ color: C.muted }}>{r.detail}</p>
            </div>
            {r.fix && (
              <Link
                href={r.fix.href}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[11px] font-medium transition-colors hover:opacity-90"
                style={{ background: C.raised, color: C.amber, border: `1px solid rgba(243,182,97,0.4)` }}
              >
                {r.fix.label} <ArrowRight size={11} aria-hidden />
              </Link>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function BrainOverviewClient({ initial }: { initial?: BrainOverview }) {
  const [data, setData] = React.useState<BrainOverview | null>(initial ?? null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(!initial);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      setData(await api<BrainOverview>("/api/admin/knowledge/overview"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the overview");
    } finally {
      setLoading(false);
    }
  }, []);
  // Server-rendered payload: show it as-is (and follow server refreshes); otherwise fetch once.
  React.useEffect(() => {
    if (initial) setData(initial);
    else void load();
  }, [initial, load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs" style={{ color: C.muted }}>
          {data ? <>Live numbers · updated {relTime(data.generatedAt)}</> : loading ? "Reading the Brain…" : "—"}
        </p>
        <KBtn onClick={() => void load()} loading={loading} aria-label="Refresh"><RefreshCw size={13} /> Refresh</KBtn>
      </div>
      <ErrorNote message={error} />
      {!data ? (
        loading ? <SkeletonPage /> : null
      ) : (
        <>
          <Hero d={data} />
          <Organised d={data} />
          <Trusts d={data} />
          <Learned d={data} />
          <Connected d={data} />
          <Fed d={data} />
          <Answers d={data} />
          <Health rows={data.health} />
          <Section title="What's inside the Brain — explained" subtitle="One plain-English card per component: what it is, what it holds right now, how the Brain uses it when answering, and where to manage it.">
            <Explainer d={data} />
          </Section>
        </>
      )}
    </div>
  );
}
