# 11 — The PractiScale AI Brain, explained (for the CEO and the team)

This page explains, in plain language, what the AI Brain is, what is inside it,
how it answers, and what every screen is for. No technical background needed.
The technical companion is [10-operating-intelligence.md](10-operating-intelligence.md).

## 1. What the Brain is

The Brain is PractiScale's institutional memory with a reasoning engine on top.
It is **not** a folder of documents and it is **not** a chatbot that "knows
things from the internet". It only answers from what PractiScale has put into
it, and it says so when it doesn't know.

Two products share it:

- **The Brain** (the back office you are reading this in): where knowledge is
  added, organised, checked and measured.
- **The Assistant** (the chat app): where the team asks questions, builds
  trainings, writes content, gets coaching — every answer grounded in the Brain.

## 2. What is inside — the five drawers

Everything the Brain holds belongs to one of five "intelligence classes".
Think of them as drawers that answer different questions:

| Drawer | The question it answers | What goes in |
| --- | --- | --- |
| **Business Reality** | *What is true / what happened?* | Pricing and offers (Company Truth), Afra's beliefs and experiences (Founder Brain), customer feedback, sales calls and scores, SOPs, manager reports, testimonials, brand voice, approved content. |
| **Playbooks** | *How should we think / what should work?* | Frameworks, principles, tactics and systems from experts, books, consultants, employees — curated, never raw. |
| **Organizational Learning** | *What have WE learned?* | Decisions → implementations → experiments → results → learnings → adaptations → PractiScale Standards. Mostly generated from real work, confirmed by a human. |
| **Platform Intelligence** | *How does each platform work?* | Per-platform formats, audience behaviour, hooks, distribution mechanics (LinkedIn, Instagram, YouTube…). |
| **Performance Memory** | *What results occurred?* | Structured numbers: call scores, close rates, campaign results, experiment outcomes. |

Plus a **Raw Archive**: original sources kept for provenance, never used as
current truth.

Every piece of knowledge is filed as **Class → Domain → Type → Subtype**
(e.g. *Playbook → Management → Framework → Accountability*) and gets a stable
reference like `MG-001` or `BR-SAL-003` that the Assistant cites.

## 3. What the Brain knows about each piece

Beyond the text itself, every knowledge object carries:

- **Authority (A1 → C3)** — what to trust when sources disagree. Current
  verified company truth (A1) beats verified data (A2), founder position (A3),
  call evidence (A4), our own learning (A5), approved playbooks (B1/B2),
  external claims (B3), and history/raw material (C1–C3). An old sales call
  saying "$500" can never override today's pricing.
- **Currency** — *when* it was true (effective from/until, last verified). A
  fact can be highly authoritative and still be out of date; the Brain knows
  the difference between "100 clients then" and "300 clients now".
- **Provenance** — who said it, where, when, what exactly they claimed, and
  whether we verified or tested it. "A creator said this" never silently
  becomes "this is proven".
- **Governance** — three separate questions the founder answers:
  *Do I believe in it?* (Interested → Approved → PractiScale Standard),
  *Have we used it?* (Not tested → Testing → Implemented),
  *Did it work?* (Unvalidated → Validated / Modified / Rejected).
- **Entities** — the people, departments, clients, offers, campaigns, KPIs and
  frameworks mentioned inside it, so "why are we losing Home Health deals?" can
  pull exactly those calls.
- **Relationships** — how it connects to other knowledge: *complements*,
  *contradicts*, *implemented in*, *validated by*, *adapted into*… so the Brain
  can walk from a framework to where we tried it, what happened, and the
  standard it became.

## 4. How knowledge gets in

You don't fill in forms. You give the Brain information and tell it which
drawer it belongs to; the **Knowledge Compiler** does the rest:

1. **Give it a source** — paste text, upload a file (PDF, document, spreadsheet),
   paste a link (a web page or a YouTube video — captions are pulled
   automatically; YouTube from the live server, blocked pages and social posts
   are read through Exa, whose key lives encrypted in Settings → Provider API
   keys), a screenshot (text is read out of the image) or a voice note
   (transcribed). A whole book, course or long report (files up to 50 MB) is
   split into its chapters and each chapter becomes its own object — one
   framework per object, not one blurry object per book.
2. **Pick the class** — Business Reality (and which bucket: Company Truth,
   Founder Brain, …) or Playbook. Or let the Brain choose the domain/type/subtype
   itself (Auto), or choose yourself.
3. **The Brain organises it** — it extracts the actual teaching, removes noise,
   names it, classifies it, pulls out entities, dates and source claims.
4. **It checks what it already knows** — *NEW* (create), *ENRICH* (add to an
   existing object and keep the new source), *DUPLICATE* (keep provenance only)
   or *CONFLICT* (keep both and mark that they disagree). 40 clips about
   delegation become one deep framework, not 40 shallow ones.
5. **It writes the canonical object** — a structured page (Definition, Problem
   it solves, Core principle, Framework, How to apply, Diagnostic, Examples,
   Failure modes, Guardrails, Source teaching, Source claims), chunked by
   idea, indexed, and connected.
6. **Every decision is logged** — the *Ingestion decisions* screen shows what
   the Brain decided and why, so it can be corrected and improved.

Guardrail: an external clip can never become **Company Truth** directly. It
enters as a Playbook, gets implemented, tested, validated, and only then can
become a PractiScale Standard.

Continuous feeds: the call-scoring system syncs every 20 minutes; each scored
call lands in Business Reality, and the Performance Memory (team average score,
close rate, per-consultant and per-market numbers, weakest phases) is rebuilt
automatically. Each call's raw transcript is pulled and stored alongside its
score, tagged with the date, consultant and practice type, so you can ask the
Assistant to review a specific day's or consultant's calls.

## 5. How the Brain answers

When someone asks the Assistant a question:

1. **Understand** — which expert job is this (Sales Coach? Training Builder?),
   which domain, which problem and goal, which time frame, and which numbers
   might matter. **Auto** picks the expert; a person can override it.
2. **Plan the search** — decide which drawers matter (a management question
   searches People & Management reality, Management playbooks and our own
   learning; it does not search Instagram hooks).
3. **Search in three ways at once** — structured filters get into the right
   neighbourhood, meaning-based search finds what *means* the same thing,
   relationships pull in what is connected, and a reranker keeps only the
   most useful evidence.
4. **Reason in order** — *what is true now* → *what we already learned* →
   *our validated standards* → *what other frameworks suggest*. Higher
   authority and more current sources win; when two sources disagree the answer
   says so.
5. **Answer with evidence** — every claim is cited; the Assistant shows the
   sources, the verified numbers it used, and any known disagreements. If the
   Brain has nothing relevant, it says it doesn't know instead of inventing.
6. **Learn from the conversation** — if a decision or result is mentioned
   ("we tried X and show-up rate improved"), the Brain offers to save it as
   Organizational Learning, listing the evidence still missing. Nothing is
   believed without a human clicking Save.

Long answers (a full 10-day training) stream completely; if an answer is
cut by a length limit, it says "send *continue*" and picks up exactly where it
stopped.

## 6. The expert modes

One Brain, many jobs. The mode changes what knowledge is prioritised and how
the answer is shaped — never the knowledge itself.

- **General**
- **Business:** CEO Advisor (private), Strategy Advisor, Sales Coach, Marketing
  Advisor, Offer Architect, Customer Success Advisor, Management Coach, Hiring
  Advisor, Operations Advisor
- **Content:** Content Strategist, Copywriter, CEO Content (private),
  Distribution Strategist
- **Build:** Training Builder, SOP Builder
- **Analysis:** Decision Memo (restricted), Research Analyst

*CREATE* = make something people consume (a post, a script). *ADVISE* = help
me decide. *BUILD* = make the whole thing people will use (a training program,
an SOP system).

## 7. The screens, and what each one is for

### The Brain (back office)

| Screen | What you do there |
| --- | --- |
| **Overview** (the landing page; Team view holds "Operations & data health") | One page with live numbers for everything: what is in each drawer, what the Brain trusts, what we've learned, how it's connected, how it's fed, how it answers, and a health checklist with the fix for anything amber. Includes the "What's inside the Brain — explained" cards. |
| **Add knowledge** | The wizard: source (paste / file / link / audio / screenshot) → class → AI review (you can correct name, class, domain, type, subtype, governance) → saved. |
| **Knowledge objects** | Everything the Brain knows, filterable by class, domain, type, status, endorsement, bucket. Open any object to see its page, provenance, relationships, entities, learning chain, decision log; edit governance or the text. |
| **Learning Lab** | The experiments memory: record decisions/implementations, attach evidence, compute results, promote a learning to a PractiScale Standard. The **Follow-ups** queue lists new evidence the Brain thinks belongs to an open experiment — attach it, compute the result, or ignore. |
| **Taxonomy** | Approve or reject the subtypes/domains/types the Brain proposes, add your own. |
| **Relationships** | Confirm or reject the connections the Brain suggests between objects; add your own. |
| **Entities** | The people, departments, clients, offers, campaigns and KPIs the Brain has recognised. |
| **Performance memory** | The numbers: call scores, close rates, per-consultant and per-market metrics; rebuild from call scores; record results manually. |
| **Ingestion decisions** | The audit trail of every automatic classification, dedup, compile, entity and relationship decision. |
| **Knowledge sources / Documents / Collections / Bulk upload / Processing runs / Data quality / Connectors** | The operational layer: feeds, files, groupings, runs, health. |
| **Query intelligence / Analytics** | How the Brain is being asked and how well it answers: grounded rate, refusals, latency, most-used sources, unanswered questions, cost. |
| **Prompts & modes / Model policy / Retrieval policy / Settings / API keys / Access & audit** | Governance: the editable instructions, model choices, retrieval knobs, provider keys, scoped keys for apps, who can do what. |

### The Assistant (chat app)

| Screen | What you do there |
| --- | --- |
| **Chat** | Ask anything. Pick the expert (or Auto), the model quality, the knowledge scope; attach files (PDF, spreadsheet, screenshot, voice note); see the live pipeline status, the "Auto → expert" chip, the evidence panel (sources with their drawer, reference and authority), the verified numbers, known disagreements, and the "save as learning" card. Compare two models, branch a conversation, export, submit for approval. |
| **Brain map** | Browse what the Brain knows: the drawers with counts, domains, search, every object with its governance, and an object page with its full text, provenance, connections and learnings. "Ask about this" starts a chat about it. |
| **My learnings** | The organisational learnings saved from chat, with their status, the playbooks they used and the evidence still missing. |
| **Admin** | Users, teams, usage, feedback, approvals, audit, RAG debugger. |

## 8. What keeps it safe

- The Brain resolves *which company* server-side from the signed-in session or
  the API key — never from the request.
- Apps reach the Brain only with a **scoped key** that limits what they can
  search and do; a spoke can narrow its access further per user (regular team
  members never see call-scoring data), never widen it.
- Retrieved and uploaded content is treated as **data, never as instructions**
  (protection against text that tries to steer the AI).
- Personal identifiers are redacted on ingest; dates, scores and ids are kept.
- Connector credentials can only be connector credentials — never a platform
  secret. Outbound fetches refuse private networks and redirects.
- Every answer is metered, logged and (optionally) checked for faithfulness.

## 9. The flywheel

Real business (calls, meetings, results) and the external world (experts,
books, frameworks) both feed the Brain. The Brain produces decisions,
trainings and content. Those produce results. Results become learnings.
Learnings become PractiScale Standards. Standards go back into the Brain — and
the next answer is better than the last.
