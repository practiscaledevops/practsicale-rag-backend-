"use client";

// The AI Brain overview — a CEO-friendly, read-at-a-glance page. Health comes
// first (it is the only block that asks for action), then the hero stats and
// how the Brain answers, is organised, what it trusts, what it learned, how it
// is connected and fed, and finally a collapsed plain-English explainer per
// component. The landing page server-renders the first payload (`initial`, from
// getBrainOverview) so nothing loads on first paint; Refresh re-fetches
// /api/admin/knowledge/overview client-side.

import * as React from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  BookOpen,
  Boxes,
  CheckCircle2,
  ChevronDown,
  Inbox,
  Layers,
  Lightbulb,
  MessageSquare,
  Network,
  RefreshCw,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  CompactStat,
  Meter,
  RelTime,
  SectionCard,
  Skeleton,
  StatGrid,
  StatTile,
  StatusDot,
  Tag,
  buttonClass,
  type BadgeTone,
} from "@/components/ui";
import { api } from "@/components/ui/brain-ui";
import { cn } from "@/lib/utils";
import { fmtDate, fmtDuration, fmtNumber, fmtPct, humanize, relTime } from "@/lib/format";
import { CLASS_DOT, CLASS_DOT_BASE, sourceTypeLabel } from "@/lib/ui-labels";
import {
  INTELLIGENCE_CLASSES,
  FOUNDER_ENDORSEMENTS,
  IMPLEMENTATION_STATUSES,
  INTERNAL_VALIDATIONS,
  LEARNING_STATUSES,
  type IntelligenceClass,
} from "@/lib/intelligence-taxonomy";
import type { BrainOverview, Labelled, HealthRow } from "@/lib/brain-overview";

/** Where each class is managed (the explorer deep-links on ?class=). */
const CLASS_HREF: Record<string, string> = {
  business_reality: "/dashboard/knowledge?class=business_reality",
  playbook: "/dashboard/knowledge?class=playbook",
  organizational_learning: "/dashboard/learning",
  platform_intelligence: "/dashboard/knowledge?class=platform_intelligence",
  performance_memory: "/dashboard/performance",
  raw_archive: "/dashboard/documents",
};

/** Class dot with a hairline ring, so the pale folder colours still read on a tint. */
function classDot(id: string, fallback = "bg-muted-foreground/40"): string {
  return cn(CLASS_DOT_BASE, CLASS_DOT[id] ?? fallback);
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

/**
 * Accent text link with an arrow. `compact` (section headers) collapses to a
 * 28px arrow button below `sm`, keeping the label for screen readers, so long
 * section descriptions keep their width on a phone.
 */
function Manage({ href, label = "Manage", compact = false }: { href: string; label?: string; compact?: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-1 rounded-md text-[13px] font-medium text-accent-strong hover:underline",
        compact &&
          "h-7 min-w-7 justify-center rounded-full px-2 hover:bg-accent-softer sm:h-auto sm:min-w-0 sm:rounded-md sm:px-0 sm:hover:bg-transparent"
      )}
    >
      <span className={compact ? "sr-only sm:not-sr-only" : undefined}>{label}</span>
      <ArrowRight size={12} aria-hidden className="shrink-0" />
    </Link>
  );
}

function Section({
  icon,
  title,
  subtitle,
  action,
  children,
  bodyClassName,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  action?: { href: string; label: string };
  children: React.ReactNode;
  bodyClassName?: string;
}) {
  return (
    <SectionCard
      icon={icon}
      title={title}
      description={subtitle}
      actions={action ? <Manage href={action.href} label={action.label} compact /> : undefined}
      bodyClassName={bodyClassName}
    >
      {children}
    </SectionCard>
  );
}

/** Compact stat inside a section. `attention` tints the value (needs a look). */
function Tile({ label, value, hint, attention = false }: { label: string; value: React.ReactNode; hint?: string; attention?: boolean }) {
  return (
    <CompactStat
      label={label}
      hint={hint}
      value={
        attention ? (
          <span className="text-warning">
            {value}
            <span className="sr-only"> (needs attention)</span>
          </span>
        ) : (
          value
        )
      }
    />
  );
}

/** Label, count and an accent meter relative to the largest item. */
function BarList({ items, empty = "Nothing yet", max }: { items: Labelled[]; empty?: string; max?: number }) {
  if (!items.length || items.every((i) => i.count === 0)) {
    return <p className="py-1 text-[13px] text-muted-foreground">{empty}</p>;
  }
  const top = max ?? Math.max(1, ...items.map((i) => i.count));
  return (
    <ul className="space-y-2">
      {items.map((i) => (
        <li key={i.id}>
          <div className="flex items-center justify-between gap-2 text-[13px]">
            <span className="truncate text-foreground" title={i.label}>
              {i.label}
            </span>
            <span className="shrink-0 font-medium tabular-nums text-foreground">{fmtNumber(i.count)}</span>
          </div>
          {/* The bar is decorative: the label and count above carry the value. */}
          <div aria-hidden className="mt-1">
            <Meter value={i.count} max={top} label={i.label} tone="accent" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function SubHead({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h3 className={cn("mb-2 text-xs font-medium text-muted-foreground", className)}>{children}</h3>;
}

/** A sub-heading with a trailing link on the same line. */
function SubHeadRow({ children, href, label }: { children: React.ReactNode; href: string; label: string }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <SubHead className="mb-0">{children}</SubHead>
      <Manage href={href} label={label} />
    </div>
  );
}

function Unavailable({ what }: { what: string }) {
  return (
    <Alert tone="info" title="Not enabled yet" role="note">
      <p>This part of the Brain isn&apos;t switched on in this environment. Ask engineering to enable it.</p>
      <details className="mt-1.5">
        <summary className="cursor-pointer text-xs">Technical details</summary>
        <p className="mt-1 text-xs text-muted-foreground">
          {what} could not be read just now. If this persists, check that the Brain migrations are applied (0014
          query log, 0017 Operating Intelligence) and that the database is reachable, then refresh.
        </p>
      </details>
    </Alert>
  );
}

function SkeletonSection({ rows = 3 }: { rows?: number }) {
  return (
    <div className="rounded-2xl border border-border bg-surface shadow-soft">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Skeleton className="h-8 w-8" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
      <div className="grid gap-4 p-4 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, j) => (
          <div key={j} className="space-y-2">
            {Array.from({ length: rows }).map((__, k) => (
              <Skeleton key={k} className={cn("h-3", k % 2 ? "w-2/3" : "w-full")} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function SkeletonPage() {
  return (
    <div className="space-y-4" role="status" aria-busy="true">
      <span className="sr-only">Loading the Brain overview…</span>
      <SkeletonSection rows={2} />
      <StatGrid cols={3}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-surface p-4 shadow-soft">
            <div className="flex items-center gap-2.5">
              <Skeleton className="h-8 w-8" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="mt-3 h-7 w-16" />
            <Skeleton className="mt-1.5 h-3 w-32" />
          </div>
        ))}
      </StatGrid>
      <SkeletonSection />
      <SkeletonSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The explainer (plain English per component, grounded in docs/10)
// ---------------------------------------------------------------------------

interface ExplainCard {
  id: string;
  title: string;
  what: string;
  /** May hold a <RelTime>: server-rendered, so time-zone-dependent text must wait for hydration. */
  holds: React.ReactNode;
  uses: string;
  href: string;
  hrefLabel: string;
}

function explainCards(d: BrainOverview): ExplainCard[] {
  const o = d.objects;
  const cls = (id: string) => fmtNumber(o?.byClass[id as IntelligenceClass]);
  const lane = (id: string) => fmtNumber(d.lanes?.chunks.byClass[id as IntelligenceClass]);
  const aLevel = o ? o.authority.filter((a) => a.id.startsWith("A")).reduce((s, a) => s + a.count, 0) : null;
  const headline = d.performance?.headline.map((h) => `${h.label.toLowerCase()} ${h.value}${h.unit ?? ""}`).join(", ");
  const topMode = d.retrieval?.byMode[0];
  return [
    {
      id: "business_reality",
      title: "Business Reality",
      what: "The record of what is actually true at PractiScale: company facts, pricing and offers, the founder's current positions, customer feedback, scored sales calls, SOPs and proof. It is the most trusted class — when two sources disagree, reality wins.",
      holds: `${cls("business_reality")} objects · ${lane("business_reality")} searchable chunks in this lane.`,
      uses: "Searched first for almost every question. The reasoning order is reality → learning → standards → playbooks, so an outside framework can never overrule a company fact.",
      href: CLASS_HREF.business_reality,
      hrefLabel: "Knowledge objects",
    },
    {
      id: "playbook",
      title: "Playbooks",
      what: "Curated frameworks, principles, tactics, scripts and templates from experts, books, consultants and our own team. A playbook is an idea about what should work — not yet proof that it did for us.",
      holds: `${cls("playbook")} objects · ${lane("playbook")} chunks · ${fmtNumber(o?.endorsement.practiscale_standard)} are PractiScale Standards.`,
      uses: "Retrieved in its own lane; ranked by relevance first, then nudged by founder endorsement, internal validation and authority (approved PractiScale playbook > approved external > unverified claim).",
      href: CLASS_HREF.playbook,
      hrefLabel: "Knowledge objects",
    },
    {
      id: "organizational_learning",
      title: "Organizational Learning",
      what: "The memory of what PractiScale decided, implemented, measured and learned — a chain of decision → implementation → experiment → result → learning → adaptation → standard. Mostly captured from real work and always confirmed by a human.",
      holds: `${fmtNumber(d.learning?.total)} records · ${fmtNumber(d.learning?.open)} still open · ${fmtNumber(d.learning?.byStatus.validated)} validated.`,
      uses: "Ranks above playbooks: 'what worked for us' outranks 'what an expert says should work'. A learning that validates a playbook can promote it to a PractiScale Standard.",
      href: "/dashboard/learning",
      hrefLabel: "Learning Lab",
    },
    {
      id: "platform_intelligence",
      title: "Platform Intelligence",
      what: "How each platform works — LinkedIn, Instagram, YouTube, email and the rest: formats, audience behaviour, hooks, distribution mechanics, native features and constraints, plus what we tested there.",
      holds: `${cls("platform_intelligence")} objects · ${lane("platform_intelligence")} chunks.`,
      uses: "Weighted up by the content experts (Content Strategist, Copywriter, Distribution) so content advice is specific to the platform it will be published on.",
      href: CLASS_HREF.platform_intelligence,
      hrefLabel: "Knowledge objects",
    },
    {
      id: "performance_memory",
      title: "Performance Memory",
      what: "The numbers, kept as structured data instead of prose: close rate, call scores, campaign results and experiment outcomes, per period and per consultant, segment or campaign. Rebuilt automatically from every call-scoring sync.",
      holds: `${fmtNumber(d.performance?.metrics)} metrics${headline ? ` · ${headline}` : ""}${d.performance?.latestPeriod ? ` · latest period ${fmtDate(d.performance.latestPeriod)}` : ""}.`,
      uses: "When a question needs numbers, the matching metrics are injected into the answer as a verified table next to the text context, so figures are quoted rather than guessed.",
      href: "/dashboard/performance",
      hrefLabel: "Performance memory",
    },
    {
      id: "raw_archive",
      title: "Raw Archive",
      what: "The original, unprocessed source material behind compiled knowledge, kept for provenance and history. Also everything ingested the old way — uploads, transcripts, call scores — as documents.",
      holds: `${fmtNumber(d.lanes?.documents.total)} documents · ${lane("raw_archive")} chunks in the raw lane.`,
      uses: "Low authority. Never presented as current truth and only searched when an analyst explicitly asks for original sources.",
      href: "/dashboard/documents",
      hrefLabel: "Documents",
    },
    {
      id: "taxonomy",
      title: "Taxonomy",
      what: "The one classification system for everything: CLASS → DOMAIN → TYPE → SUBTYPE plus open tags. A domain says what a piece of knowledge is about (Sales, Management, Content…), never where it came from.",
      holds: `${fmtNumber(d.taxonomy?.approved)} approved custom values · ${fmtNumber(d.taxonomy?.pending)} AI proposals waiting for approval.`,
      uses: "The intent classifier maps every question to domains and types, and the orchestrator boosts objects that fit — a soft nudge, never a hard filter, so nothing relevant is hidden.",
      href: "/dashboard/taxonomy",
      hrefLabel: "Taxonomy",
    },
    {
      id: "entities",
      title: "Entities",
      what: "The WHO and WHAT inside the knowledge: people, departments, clients, offers, campaigns, platforms, frameworks and KPIs. Extracted automatically when knowledge is compiled and when call scores are rebuilt.",
      holds: `${fmtNumber(d.graph?.entities.total)} entities${d.graph?.entities.byKind[0] ? ` · most common: ${d.graph.entities.byKind[0].label.toLowerCase()} (${d.graph.entities.byKind[0].count})` : ""}.`,
      uses: "When a question names a consultant, client or offer, the Brain recognises the entity and pulls the objects that mention the same one.",
      href: "/dashboard/entities",
      hrefLabel: "Entities",
    },
    {
      id: "relationships",
      title: "Relationships",
      what: "Links between objects — complements, contradicts, implemented in, validated by, used the playbook, adapted into. The AI suggests them; a human confirms or rejects.",
      holds: `${fmtNumber(d.graph?.relationships.confirmed)} confirmed · ${fmtNumber(d.graph?.relationships.suggested)} suggested and waiting for review.`,
      uses: "After retrieval the Brain takes one hop over confirmed links, so an answer about a playbook can bring in the learning that validated it — or the object that contradicts it.",
      href: "/dashboard/relationships",
      hrefLabel: "Relationships",
    },
    {
      id: "authority",
      title: "Authority & currency",
      what: "Authority (A1 verified company truth … C3 archive) says what to believe when sources conflict. The temporal fields (effective from / until, last verified) say whether something is still current.",
      holds: `${fmtNumber(aLevel)} objects at A-level trust · ${fmtNumber(o?.currency.current)} current · ${fmtNumber(o?.currency.expired)} expired · ${fmtNumber(o?.currency.historical)} historical · ${fmtNumber(o?.needsVerification.count)} need re-verification.`,
      uses: "Both nudge ranking, and every piece of context is labelled with its authority and currency so the model knows what it is reading. Expired or historical objects are never presented as current truth.",
      href: "/dashboard/knowledge?status=historical",
      hrefLabel: "Knowledge objects",
    },
    {
      id: "provenance",
      title: "Provenance",
      what: "Who said it, where, when and what they claimed — kept separately from what has been proven. Every object carries its sources and the claims made by them.",
      holds: `${fmtNumber(o?.total)} objects carry provenance · ${fmtNumber(o?.endorsement.approved)} approved and ${fmtNumber(o?.endorsement.practiscale_standard)} standardised by the founder · ${fmtNumber(o?.validation.validated)} validated internally.`,
      uses: "A guard: an outside expert or social post can never establish Company Truth without an explicit confirmation. Source claims are listed apart from validated facts in every compiled object.",
      href: "/dashboard/knowledge",
      hrefLabel: "Knowledge objects",
    },
    {
      id: "work_modes",
      title: "Work modes & Auto",
      what: "One Brain, many experts: CEO Advisor, Strategy, Sales Coach, Marketing, Offer Architect, Content Strategist, Copywriter, SOP Builder, Decision Memo and more. Each mode is a retrieval policy plus a reasoning style. Auto lets the Brain pick the expert.",
      holds: `${fmtNumber(d.retrieval?.queries)} questions answered this week${topMode ? ` · busiest expert: ${topMode.label} (${topMode.count})` : ""} · Auto mode ${d.flags.autoWorkMode ? "on" : "off"}.`,
      uses: "The mode decides which lanes matter most and which domains are boosted, then frames the job as CREATE, ADVISE or BUILD.",
      href: "/dashboard/prompts",
      hrefLabel: "Prompts",
    },
    {
      id: "compiler",
      title: "Knowledge Compiler & dedup",
      what: "How knowledge gets in: give the Brain information and its class, and it classifies, fits the taxonomy, checks for duplicates (new / enrich / duplicate / conflict), compiles a canonical page and stores it with entities and relationships. Every decision is logged.",
      holds: (
        <>
          {fmtNumber(d.ingestion?.decisionsLast7d)} automatic decisions this week · last one{" "}
          <RelTime iso={d.ingestion?.lastDecisionAt} />
          {d.ingestion
            ? ` · 30-day dedup: ${d.ingestion.dedupLast30d.new} new, ${d.ingestion.dedupLast30d.enrich} enriched, ${d.ingestion.dedupLast30d.duplicate} duplicates, ${d.ingestion.dedupLast30d.conflict} conflicts`
            : ""}
          .
        </>
      ),
      uses: "A conflict creates both objects and links them as contradicting, so the disagreement is visible in answers instead of silently picking one side.",
      href: "/dashboard/knowledge/add",
      hrefLabel: "Add knowledge",
    },
    {
      id: "orchestrator",
      title: "Retrieval orchestrator",
      what: "The part that answers. It understands the question (expert, job, domains, entities, whether numbers are needed), plans which lanes to search, searches them in parallel, nudges by fit and trust, expands over relationships, reranks, and hands the model lane-grouped context with identity headers.",
      holds: `${d.flags.orchestrator ? "Enabled" : "Off (classic pipeline)"} · grounded rate ${fmtPct(d.retrieval?.groundedRate)} · ${fmtNumber(d.retrieval?.refusals)} refusals this week · average answer ${fmtDuration(d.retrieval?.avgLatencyMs)}.`,
      uses: "Ground or refuse: the Brain answers only from what it retrieved and says so when the knowledge is not there.",
      href: "/dashboard/retrieval-policy",
      hrefLabel: "Retrieval policy",
    },
    {
      id: "learning_detection",
      title: "Learning detection",
      what: "The Brain watches conversations for a decision, an implementation, a result or a lesson, and offers to save it as organizational learning. Nothing is believed until a person confirms it.",
      holds: `${d.flags.learningDetection ? "Enabled" : "Off"} · ${fmtNumber(d.learning?.pendingFollowUps)} open learnings still missing evidence · ${fmtNumber(d.learning?.suggestedEvidenceEdges)} suggested evidence links to review.`,
      uses: "Confirmed learning enters the lifecycle, links to the playbooks it used, and can promote them to PractiScale Standards.",
      href: "/dashboard/learning",
      hrefLabel: "Learning Lab",
    },
  ];
}

/** "How the Brain works": collapsed by default, one expandable card per component. */
function Explainer({ d }: { d: BrainOverview }) {
  const cards = explainCards(d);
  return (
    <details className="group/explainer rounded-2xl border border-border bg-surface shadow-soft">
      <summary className="flex cursor-pointer list-none items-start gap-3 rounded-2xl px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
          <BookOpen size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-foreground">How the Brain works</span>
          <span className="mt-0.5 block text-[13px] text-muted-foreground">
            One plain-English card per component: what it is, what it holds right now, how the Brain uses it when
            answering, and where to manage it.
          </span>
        </span>
        <ChevronDown
          size={14}
          aria-hidden
          className="mt-2 shrink-0 text-muted-foreground transition-transform group-open/explainer:rotate-180"
        />
      </summary>
      <div className="grid items-start gap-2 border-t border-border p-4 md:grid-cols-2">
        {cards.map((c) => (
          <details key={c.id} className="group/card rounded-xl bg-surface-muted">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2.5 text-[13px] font-medium text-foreground [&::-webkit-details-marker]:hidden">
              <span aria-hidden className={classDot(c.id, "bg-accent")} />
              <span className="flex-1">{c.title}</span>
              <ChevronDown
                size={14}
                aria-hidden
                className="shrink-0 text-muted-foreground transition-transform group-open/card:rotate-180"
              />
            </summary>
            <div className="space-y-2 border-t border-border px-3 pb-3 pt-2 text-[13px] leading-5 text-foreground">
              <p>
                <span className="font-medium text-muted-foreground">What it is · </span>
                {c.what}
              </p>
              <p>
                <span className="font-medium text-muted-foreground">What it holds now · </span>
                <span className="font-medium">{c.holds}</span>
              </p>
              <p>
                <span className="font-medium text-muted-foreground">How the Brain uses it · </span>
                {c.uses}
              </p>
              <Manage href={c.href} label={`Manage in ${c.hrefLabel}`} />
            </div>
          </details>
        ))}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function Health({ rows }: { rows: HealthRow[] }) {
  const warn = rows.filter((r) => r.status === "warn").length;
  return (
    <SectionCard
      icon={Activity}
      title="Brain health"
      description={
        warn === 0
          ? "Everything is green. Nothing needs your attention."
          : `${warn} item${warn === 1 ? " needs" : "s need"} attention.`
      }
      bodyClassName="p-0"
    >
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.id} className="flex items-start gap-3 px-4 py-2.5">
            {r.status === "ok" ? (
              <CheckCircle2 size={16} aria-hidden className="mt-0.5 shrink-0 text-success" />
            ) : (
              <AlertTriangle size={16} aria-hidden className="mt-0.5 shrink-0 text-warning" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-foreground">
                <span className="sr-only">{r.status === "ok" ? "OK: " : "Needs attention: "}</span>
                {r.label}
              </p>
              <p className="text-xs text-muted-foreground">{r.detail}</p>
            </div>
            {r.fix && (
              <Link href={r.fix.href} className={buttonClass({ variant: "secondary", size: "sm", className: "shrink-0" })}>
                {r.fix.label}
                <ArrowRight size={12} aria-hidden />
              </Link>
            )}
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function Hero({ d }: { d: BrainOverview }) {
  return (
    <section aria-label="Key numbers">
      <StatGrid cols={3}>
        <StatTile
          icon={Boxes}
          label="Knowledge objects"
          value={fmtNumber(d.objects?.total)}
          hint="Compiled, classified pieces of intelligence"
          href="/dashboard/knowledge"
        />
        <StatTile
          icon={Lightbulb}
          label="Learnings"
          value={fmtNumber(d.learning?.total)}
          hint="Decisions, experiments and results we recorded"
          href="/dashboard/learning"
        />
        <StatTile
          icon={Network}
          label="Relationships"
          value={fmtNumber(d.graph?.relationships.confirmed)}
          hint="Confirmed links between objects"
          href="/dashboard/relationships"
        />
        <StatTile
          icon={Users}
          label="Entities"
          value={fmtNumber(d.graph?.entities.total)}
          hint="People, clients, offers and platforms it knows"
          href="/dashboard/entities"
        />
        <StatTile
          icon={BarChart3}
          label="Metrics"
          value={fmtNumber(d.performance?.metrics)}
          hint="Numbers in Performance Memory"
          href="/dashboard/performance"
        />
        <StatTile
          icon={MessageSquare}
          label="Queries this week"
          value={fmtNumber(d.retrieval?.queries)}
          hint="Questions answered through the API"
          href="/dashboard/quality"
        />
      </StatGrid>
    </section>
  );
}

function Answers({ d }: { d: BrainOverview }) {
  const r = d.retrieval;
  const flags: { label: string; on: boolean }[] = [
    { label: "Orchestrator", on: d.flags.orchestrator },
    { label: "Auto mode", on: d.flags.autoWorkMode },
    { label: "Relationship expansion", on: d.flags.relationshipExpansion },
    { label: "Learning detection", on: d.flags.learningDetection },
  ];
  return (
    <Section
      icon={MessageSquare}
      title="How it answers"
      subtitle="Last 7 days through the public API. Auto mode picks the expert; ground-or-refuse keeps it honest."
      action={{ href: "/dashboard/quality", label: "Query intelligence" }}
    >
      {!r ? (
        <Unavailable what="Query logging" />
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          <div className="grid grid-cols-2 content-start gap-2">
            <Tile label="Queries" value={fmtNumber(r.queries)} hint="This week" />
            <Tile
              label="Grounded rate"
              value={fmtPct(r.groundedRate)}
              hint="Answers backed by retrieved knowledge"
              attention={r.groundedRate !== null && r.groundedRate < 0.8}
            />
            <Tile
              label="Refusals"
              value={fmtNumber(r.refusals)}
              hint="Said “I don't know” instead of guessing"
              attention={r.refusals > 0}
            />
            <Tile
              label="Avg latency"
              value={fmtDuration(r.avgLatencyMs)}
              hint={r.answersWithLatency ? `${fmtNumber(r.answersWithLatency)} answers measured` : "No answers measured"}
            />
          </div>
          <div>
            <SubHead>Questions by expert (work mode)</SubHead>
            <BarList items={r.byMode} empty="No questions this week." />
            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1" aria-label="Pipeline switches">
              {flags.map((f) => (
                <li key={f.label}>
                  <StatusDot tone={f.on ? "success" : "neutral"}>
                    {f.label} {f.on ? "on" : "off"}
                  </StatusDot>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Section>
  );
}

function ClassCard({ id, d }: { id: string; d: BrainOverview }) {
  const def = INTELLIGENCE_CLASSES.find((c) => c.id === id)!;
  const count = d.objects?.byClass[id as IntelligenceClass];
  const chunks = d.lanes?.chunks.byClass[id as IntelligenceClass];
  const domains = d.objects?.topDomainsByClass[id] ?? [];
  const isLearning = id === "organizational_learning";
  const isPerf = id === "performance_memory";
  return (
    <div className="flex flex-col rounded-xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <span aria-hidden className={classDot(id)} />
            {def.label}
          </h3>
          <p className="mt-0.5 text-xs italic text-muted-foreground">{def.question}</p>
        </div>
        <Badge tone={def.core ? "strong" : "neutral"}>{def.core ? "Core" : "Supporting"}</Badge>
      </div>
      <p className="mt-3 text-[22px] font-semibold leading-7 tracking-tight tabular-nums text-foreground">
        {isLearning ? fmtNumber(d.learning?.total ?? count) : isPerf ? fmtNumber(d.performance?.metrics) : fmtNumber(count)}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {isLearning ? "learning records" : isPerf ? "metrics" : "objects"} · {fmtNumber(chunks)} chunks in this lane
        {isPerf && count ? ` · ${fmtNumber(count)} snapshot objects` : ""}
      </p>
      <div className="mt-3 flex min-h-[22px] flex-wrap gap-1">
        {domains.length ? (
          domains.map((x) => (
            <Tag key={x.id}>
              {x.label} · {x.count}
            </Tag>
          ))
        ) : (
          <span className="text-xs text-muted-foreground">No domains yet</span>
        )}
      </div>
      <div className="mt-auto pt-3">
        <Manage href={CLASS_HREF[id]} />
      </div>
    </div>
  );
}

function Organised({ d }: { d: BrainOverview }) {
  const raw = d.objects?.byClass.raw_archive;
  return (
    <Section
      icon={Layers}
      title="How the Brain is organised"
      subtitle="Three core intelligence classes the team feeds, two supporting systems the Brain feeds itself."
      action={{ href: "/dashboard/knowledge", label: "All objects" }}
    >
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {["business_reality", "playbook", "organizational_learning"].map((id) => (
          <ClassCard key={id} id={id} d={d} />
        ))}
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {["platform_intelligence", "performance_memory"].map((id) => (
          <ClassCard key={id} id={id} d={d} />
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Plus the <span className="font-medium text-foreground">Raw Archive</span>: {fmtNumber(d.lanes?.documents.total)}{" "}
        documents and {fmtNumber(d.lanes?.chunks.byClass.raw_archive)} raw chunks
        {raw ? ` (${fmtNumber(raw)} archive objects)` : ""} kept for provenance, searched only on request.{" "}
        {fmtNumber(d.lanes?.chunks.embedded)} of {fmtNumber(d.lanes?.chunks.total)} chunks are embedded and searchable.
        {d.objects?.capped ? " Distribution figures are sampled from the newest 5,000 objects." : ""}
      </p>
    </Section>
  );
}

function Trusts({ d }: { d: BrainOverview }) {
  const o = d.objects;
  if (!o) {
    return (
      <Section icon={ShieldCheck} title="What the Brain trusts">
        <Unavailable what="Trust and governance" />
      </Section>
    );
  }
  const endorse: Labelled[] = FOUNDER_ENDORSEMENTS.map((e) => ({ id: e.id, label: e.label, count: o.endorsement[e.id] }));
  const impl: Labelled[] = IMPLEMENTATION_STATUSES.map((s) => ({ id: s.id, label: s.label, count: o.implementation[s.id] ?? 0 }));
  const val: Labelled[] = INTERNAL_VALIDATIONS.map((s) => ({ id: s.id, label: s.label, count: o.validation[s.id] ?? 0 }));
  const authority: Labelled[] = o.authority.map((a) => ({ ...a, label: `${a.id} · ${a.label}` }));
  const total = Math.max(1, o.currency.current + o.currency.expired + o.currency.historical);
  const share = (v: number) => ({ width: `${(v / total) * 100}%` });
  return (
    <Section
      icon={ShieldCheck}
      title="What the Brain trusts"
      subtitle="Authority says what wins when sources disagree; endorsement, implementation and validation say how proven it is; currency says whether it is still true."
      action={{ href: "/dashboard/knowledge", label: "Review governance" }}
    >
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        <div>
          <SubHead>Authority ladder (A1 = most trusted)</SubHead>
          <BarList items={authority} />
        </div>
        <div className="space-y-5">
          <div>
            <SubHead>Founder endorsement pipeline</SubHead>
            <div className="grid grid-cols-3 gap-2">
              {endorse.map((e) => (
                <Tile key={e.id} label={e.label} value={fmtNumber(e.count)} />
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {fmtNumber(o.endorsement.none)} objects have no endorsement yet.
            </p>
          </div>
          <div>
            <SubHead>Implementation</SubHead>
            <BarList items={impl} />
          </div>
          <div>
            <SubHead>Internal validation</SubHead>
            <BarList items={val} />
          </div>
        </div>
        <div className="space-y-5">
          <div>
            <SubHead>Currency</SubHead>
            <div aria-hidden className="flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
              <div className="bg-success" style={share(o.currency.current)} />
              <div className="bg-warning" style={share(o.currency.expired)} />
              <div className="bg-muted-foreground/50" style={share(o.currency.historical)} />
            </div>
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              <li>
                <StatusDot tone="success">
                  Current <span className="font-medium tabular-nums">{fmtNumber(o.currency.current)}</span>
                </StatusDot>
              </li>
              <li>
                <StatusDot tone={o.currency.expired ? "warning" : "neutral"}>
                  Expired <span className="font-medium tabular-nums">{fmtNumber(o.currency.expired)}</span>
                </StatusDot>
              </li>
              <li>
                <StatusDot tone="neutral">
                  Historical <span className="font-medium tabular-nums">{fmtNumber(o.currency.historical)}</span>
                </StatusDot>
              </li>
            </ul>
          </div>
          <div>
            <SubHead>Needs re-verification ({fmtNumber(o.needsVerification.count)})</SubHead>
            {o.needsVerification.count === 0 ? (
              <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                <CheckCircle2 size={14} aria-hidden className="shrink-0 text-success" />
                Everything was verified in the last 90 days.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {o.needsVerification.examples.map((x) => (
                  <li key={x.ref} className="flex items-center justify-between gap-2 text-[13px]">
                    <span className="min-w-0 truncate text-foreground">
                      <span className="font-mono text-xs text-muted-foreground">{x.ref}</span> {x.name}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {x.lastVerifiedAt ? fmtDate(x.lastVerifiedAt) : "never"}
                    </span>
                  </li>
                ))}
                {o.needsVerification.count > o.needsVerification.examples.length && (
                  <li className="text-xs text-muted-foreground">
                    + {fmtNumber(o.needsVerification.count - o.needsVerification.examples.length)} more
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>
      </div>
    </Section>
  );
}

/** Learning-status chips: validated is healthy, rejected failed, the rest neutral. */
function learningTone(id: string): BadgeTone {
  return id === "validated" ? "success" : id === "rejected" ? "danger" : "neutral";
}

function Learned({ d }: { d: BrainOverview }) {
  const l = d.learning;
  if (!l) {
    return (
      <Section icon={Lightbulb} title="What we have learned">
        <Unavailable what="Organizational Learning" />
      </Section>
    );
  }
  const statuses: Labelled[] = LEARNING_STATUSES.map((s) => ({ id: s.id, label: s.label, count: l.byStatus[s.id] ?? 0 })).filter((s) => s.count > 0);
  const experiments = l.funnel.find((f) => f.id === "experiment")?.count ?? 0;
  return (
    <Section
      icon={Lightbulb}
      title="What we have learned"
      subtitle="The lifecycle every learning walks: decision → implementation → experiment → result → learning → adaptation → PractiScale Standard."
      action={{ href: "/dashboard/learning", label: "Learning Lab" }}
    >
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <SubHead>Lifecycle funnel</SubHead>
          <BarList items={l.funnel} empty="No learning recorded yet — save one from a chat or the Learning Lab." />
        </div>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <Tile label="Open work" value={fmtNumber(l.open)} hint="Open · implementing · measuring" />
            <Tile label="Experiments" value={fmtNumber(experiments)} hint="Recorded so far" />
            <Tile
              label="Pending follow-ups"
              value={fmtNumber(l.pendingFollowUps)}
              hint="Open records missing evidence"
              attention={l.pendingFollowUps > 0}
            />
            <Tile
              label="Evidence to review"
              value={fmtNumber(l.suggestedEvidenceEdges)}
              hint="AI-suggested evidence links"
              attention={l.suggestedEvidenceEdges > 0}
            />
          </div>
          <div>
            <SubHead>By status</SubHead>
            <div className="flex flex-wrap gap-1">
              {statuses.length ? (
                statuses.map((s) => (
                  <Badge key={s.id} tone={learningTone(s.id)}>
                    {s.label} · {s.count}
                  </Badge>
                ))
              ) : (
                <span className="text-[13px] text-muted-foreground">—</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

function Connected({ d }: { d: BrainOverview }) {
  const g = d.graph;
  if (!g) {
    return (
      <Section icon={Network} title="How it is connected">
        <Unavailable what="The knowledge graph" />
      </Section>
    );
  }
  return (
    <Section
      icon={Network}
      title="How it is connected"
      subtitle="Entities are the who and what; relationships are the links the Brain follows when it answers."
      action={{ href: "/dashboard/relationships", label: "Relationships" }}
    >
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <SubHeadRow href="/dashboard/entities" label="Entities">
            Entities by kind · {fmtNumber(g.entities.total)} total
          </SubHeadRow>
          <BarList items={g.entities.byKind} empty="No entities extracted yet." />
        </div>
        <div>
          <div className="mb-4 grid grid-cols-3 gap-2">
            <Tile label="Confirmed" value={fmtNumber(g.relationships.confirmed)} />
            <Tile
              label="Suggested"
              value={fmtNumber(g.relationships.suggested)}
              hint="Waiting for review"
              attention={g.relationships.suggested > 0}
            />
            <Tile label="Rejected" value={fmtNumber(g.relationships.rejected)} />
          </div>
          <SubHead>Relationships by type</SubHead>
          <BarList items={g.relationships.byType} empty="No links yet — the compiler suggests them as knowledge is added." />
        </div>
      </div>
    </Section>
  );
}

function Fed({ d }: { d: BrainOverview }) {
  const ing = d.ingestion;
  const tax = d.taxonomy;
  const docs = d.lanes?.documents;
  const docItems: Labelled[] = docs
    ? Object.entries(docs.bySourceType).map(([id, count]) => ({ id, label: sourceTypeLabel(id), count }))
    : [];
  return (
    <Section
      icon={Inbox}
      title="How it is fed"
      subtitle="Every piece of knowledge passes through the compiler: classify → taxonomy → dedup → compile → persist. Every decision is logged."
      action={{ href: "/dashboard/knowledge/add", label: "Add knowledge" }}
    >
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
        <div>
          <SubHeadRow href="/dashboard/decisions" label="Log">
            Decisions this week · {fmtNumber(ing?.decisionsLast7d)}
          </SubHeadRow>
          {ing ? (
            <BarList items={ing.byStage} empty="No automatic decisions in the last 7 days." />
          ) : (
            <Unavailable what="The decision log" />
          )}
          {ing && (
            <p className="mt-2 text-xs text-muted-foreground">
              Last decision <RelTime iso={ing.lastDecisionAt} />.
            </p>
          )}
        </div>
        <div>
          <SubHead>Dedup outcomes · last 30 days</SubHead>
          {ing ? (
            <div className="grid grid-cols-2 gap-2">
              <Tile label="New" value={fmtNumber(ing.dedupLast30d.new)} />
              <Tile label="Enriched" value={fmtNumber(ing.dedupLast30d.enrich)} />
              <Tile label="Duplicates" value={fmtNumber(ing.dedupLast30d.duplicate)} />
              <Tile label="Conflicts" value={fmtNumber(ing.dedupLast30d.conflict)} attention={ing.dedupLast30d.conflict > 0} />
            </div>
          ) : (
            <Unavailable what="Dedup history" />
          )}
        </div>
        <div>
          <SubHeadRow href="/dashboard/taxonomy" label="Taxonomy">
            Taxonomy proposals · {fmtNumber(tax?.pending)} pending
          </SubHeadRow>
          {tax ? (
            tax.latestProposals.length ? (
              <ul className="space-y-1.5">
                {tax.latestProposals.map((p, i) => (
                  <li key={`${p.kind}-${p.value}-${i}`} className="flex items-center justify-between gap-2 text-[13px]">
                    <span className="min-w-0 truncate text-foreground">
                      <Badge tone="neutral" className="mr-1.5">
                        {humanize(p.kind)}
                      </Badge>
                      {p.value}
                      {p.domain ? (
                        <span className="text-muted-foreground">
                          {" "}
                          · {p.domain}
                          {p.objectType ? `/${p.objectType}` : ""}
                        </span>
                      ) : null}
                    </span>
                    <RelTime iso={p.createdAt} className="shrink-0 text-xs text-muted-foreground" />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="flex items-start gap-1.5 text-[13px] text-muted-foreground">
                <CheckCircle2 size={14} aria-hidden className="mt-0.5 shrink-0 text-success" />
                <span>Nothing waiting. {fmtNumber(tax.approved)} approved custom values in use.</span>
              </p>
            )
          ) : (
            <Unavailable what="The taxonomy queue" />
          )}
        </div>
        <div>
          <SubHeadRow href="/dashboard/uploads" label="Upload">
            Documents by source · {fmtNumber(docs?.total)}
          </SubHeadRow>
          <BarList items={docItems} empty="No documents yet." />
        </div>
      </div>
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
        <p className="text-xs text-muted-foreground" suppressHydrationWarning>
          {data ? <>Live numbers · updated {relTime(data.generatedAt)}</> : loading ? "Reading the Brain…" : "—"}
        </p>
        <Button
          variant="secondary"
          size="toolbar"
          onClick={() => void load()}
          disabled={loading}
          aria-busy={loading || undefined}
        >
          <RefreshCw size={14} aria-hidden className={cn("shrink-0", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {!data ? (
        loading ? <SkeletonPage /> : null
      ) : (
        <>
          <Health rows={data.health} />
          <Hero d={data} />
          <Answers d={data} />
          <Organised d={data} />
          <Trusts d={data} />
          <Learned d={data} />
          <Connected d={data} />
          <Fed d={data} />
          <Explainer d={data} />
        </>
      )}
    </div>
  );
}
