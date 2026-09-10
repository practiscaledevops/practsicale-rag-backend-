// Ingest the PractiScale knowledge pack into the Brain, organized by the four
// retrieval scopes the pack defines:
//   company_truth      — what PractiScale is/sells, audiences, sales philosophy,
//                        process, operations. Authoritative facts.
//   company_brand      — how the COMPANY writes (voice, copywriting rules, methods).
//   founder_brand      — how Afra's founder brand writes.
//   approved_examples  — previously approved content. STYLE references, NOT facts.
//
// Each scope becomes a Collection, so scoped keys can grant access per scope.
// Every document is tagged with provenance metadata (scope, source_file,
// authoritative, knowledge_pack) so retrieval/answers can respect it.
//
//   npm run ingest:knowledge
//
// Idempotent: deletes any prior knowledge_pack=v1 documents first, then re-ingests
// — so re-running (e.g. after adding an OpenAI key) refreshes embeddings cleanly.

import { readFileSync } from "fs";
import { join } from "path";

// Minimal .env.local loader (must run BEFORE importing modules that build clients).
function loadEnvLocal(path = ".env.local"): void {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvLocal();

type Scope = "company_truth" | "company_brand" | "founder_brand" | "approved_examples";

interface Entry {
  file: string;
  scope: Scope;
  title: string;
  authoritative: boolean;
}

const KNOWLEDGE_DIR = "knowledge";

// Classification is by DOCUMENT CONTENT (the pack's temp filenames don't match
// their headers). company_truth/brand/founder are authoritative guidance;
// approved_examples are style references only.
const MANIFEST: Entry[] = [
  // ---- company_truth ----
  { file: "00_FOUNDER_PROFILE.md", scope: "company_truth", title: "Founder Profile — Afra", authoritative: true },
  { file: "04_SALES_AND_PERSUASION_PHILOSOPHY.md", scope: "company_truth", title: "PractiScale Company Brain — What PractiScale Does", authoritative: true },
  { file: "05_SALES_PROCESS.md", scope: "company_truth", title: "Offers and Pricing", authoritative: true },
  { file: "06_OPERATIONS_AND_DELIVERY.md", scope: "company_truth", title: "Audiences and Customer Psychology", authoritative: true },
  { file: "01_PRACTISCALE_BRAND_VOICE.md", scope: "company_truth", title: "Sales and Persuasion Philosophy", authoritative: true },
  { file: "02_COPYWRITING_RULES.md", scope: "company_truth", title: "PractiScale Sales Process", authoritative: true },
  { file: "01_AFRA_WRITING_DNA.md", scope: "company_truth", title: "PractiScale Operations and Delivery", authoritative: true },
  // ---- company_brand ----
  { file: "03_GOLD_STANDARD_QUOTES.md", scope: "company_brand", title: "PractiScale Brand Voice", authoritative: true },
  { file: "04_TRANSCRIPT_TO_OUTPUT_METHOD.md", scope: "company_brand", title: "Copywriting Rules", authoritative: true },
  { file: "02_APPROVED_QUOTE_LIBRARY.md", scope: "company_brand", title: "Output Style Guide", authoritative: true },
  { file: "04_APPROVED_IDEA_DUMP.md", scope: "company_brand", title: "Transcript-to-Output Method", authoritative: true },
  { file: "05_APPROVED_VIDEO_IDEA_LIBRARY.md", scope: "company_brand", title: "Caption and Short-Form Style", authoritative: true },
  // ---- founder_brand ----
  { file: "01_APPROVED_CONTENT_PROMPT.md", scope: "founder_brand", title: "Afra Writing DNA", authoritative: true },
  { file: "07_APPROVED_WRITING_LIBRARY_GUIDE.md", scope: "founder_brand", title: "Approved Content Prompt (CEO Repurposing Brief)", authoritative: true },
  // ---- approved_examples (style references, NOT facts) ----
  { file: "03_APPROVED_CAROUSEL_LIBRARY.md", scope: "approved_examples", title: "Gold Standard Quotes", authoritative: false },
  { file: "01_KNOWLEDGE_MANIFEST.md", scope: "approved_examples", title: "Approved Quote Library (CEO Quotations Log)", authoritative: false },
  { file: "02_SOURCE_OF_TRUTH_AND_PROVENANCE.md", scope: "approved_examples", title: "Approved Carousel Library", authoritative: false },
  { file: "03_RETRIEVAL_SCOPES_AND_PERMISSIONS.md", scope: "approved_examples", title: "Approved Idea Dump", authoritative: false },
  { file: "04_SALES_INTELLIGENCE_DATA_ARCHITECTURE.md", scope: "approved_examples", title: "Approved Video Idea Library", authoritative: false },
  { file: "05_INGESTION_RULES.md", scope: "approved_examples", title: "Approved Caption Library", authoritative: false },
  { file: "06_DEVELOPER_HANDOFF.md", scope: "approved_examples", title: "Approved Writing Library Guide", authoritative: false },
];

const SCOPE_DESCRIPTIONS: Record<Scope, string> = {
  company_truth: "Authoritative facts: what PractiScale is/sells, audiences, sales philosophy, process, operations.",
  company_brand: "How the company communicates: brand voice, copywriting rules, and writing methods.",
  founder_brand: "How Afra's founder/personal brand communicates.",
  approved_examples: "Previously approved content used as STYLE references, not authoritative facts.",
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`✖ Missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

async function main() {
  required("NEXT_PUBLIC_SUPABASE_URL");
  required("SUPABASE_SERVICE_ROLE_KEY");

  // Lazy imports AFTER env is loaded (these build Supabase clients at import).
  const { supabaseAdmin } = await import("../src/lib/supabase");
  const { ingestOne } = await import("../src/lib/ingest");
  const { loadSettings, saveSettings } = await import("../src/lib/settings");
  const db = supabaseAdmin();

  // Resolve the org.
  const { data: org } = await db
    .from("orgs")
    .select("id, name")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!org) throw new Error("no org found — run setup:live first");
  const orgId = org.id as string;
  console.log(`• Org: ${org.name} (${orgId})`);

  // Ensure contextual retrieval is ON for this ingest. It runs on Anthropic (no
  // OpenAI needed) and prepends a short descriptive blurb to each chunk before
  // indexing — which enriches the KEYWORD index (e.g. adds words like "pricing"
  // to a "$300 tiers" chunk), so natural-language/paraphrased queries match even
  // while vector search is dormant. It also primes proper contextual embeddings
  // for when an OpenAI key is added.
  const { settings } = await loadSettings(orgId, db);
  if (!settings.features.contextualRetrieval) {
    await saveSettings(orgId, { ...settings, features: { ...settings.features, contextualRetrieval: true } }, null, db);
    console.log("• Enabled contextual retrieval for this ingest.");
  }

  // Ensure the four scope collections exist.
  const scopeToCollection: Record<string, string> = {};
  for (const scope of Object.keys(SCOPE_DESCRIPTIONS) as Scope[]) {
    const { data, error } = await db
      .from("collections")
      .upsert(
        { org_id: orgId, name: scope, slug: scope, description: SCOPE_DESCRIPTIONS[scope] },
        { onConflict: "org_id,slug" }
      )
      .select("id")
      .single();
    if (error) throw new Error(`collection ${scope}: ${error.message}`);
    scopeToCollection[scope] = data.id as string;
    console.log(`✓ Collection ready: ${scope} (${data.id})`);
  }

  // Clear any prior knowledge-pack docs so re-runs refresh cleanly.
  const { error: delErr } = await db
    .from("documents")
    .delete()
    .eq("org_id", orgId)
    .filter("metadata->>knowledge_pack", "eq", "v1");
  if (delErr) console.warn(`(cleanup) ${delErr.message}`);

  // Ingest each document into its scope collection.
  let ok = 0;
  let chunks = 0;
  for (const e of MANIFEST) {
    let text: string;
    try {
      text = readFileSync(join(KNOWLEDGE_DIR, e.file), "utf-8");
    } catch {
      console.warn(`✖ missing file: ${e.file} (skipped)`);
      continue;
    }
    const res = await ingestOne(db, {
      orgId,
      sourceType: "document",
      title: e.title,
      text,
      uri: `knowledge/${e.file}`,
      metadata: {
        knowledge_pack: "v1",
        scope: e.scope,
        authoritative: e.authoritative,
        source_file: e.file,
        // Keep the raw text so the document can be re-ingested from the DB later.
        source_text: text,
      },
      collectionIds: [scopeToCollection[e.scope]],
    });
    ok += 1;
    chunks += res.chunks;
    console.log(`✓ ${e.scope.padEnd(17)} ${e.title}  (${res.chunks} chunks${res.skipped ? ", skipped" : ""})`);
  }

  // Let the chatbot's scoped key read ALL knowledge (call scores + documents +
  // every scope), not just call_score. Empty source_types/collections = no
  // restriction. This is the internal assistant, so full read is intended.
  const { error: keyErr } = await db
    .from("api_keys")
    .update({ source_types: [], collection_ids: [] })
    .eq("org_id", orgId)
    .eq("name", "chatbot")
    .is("revoked_at", null);
  if (keyErr) console.warn(`(key update) ${keyErr.message}`);
  else console.log("✓ Broadened the chatbot key to all source types + collections.");

  console.log(`\n✓ Ingested ${ok}/${MANIFEST.length} documents, ${chunks} chunks across 4 scopes.`);
  console.log("  Note: embeddings are zero until an OpenAI key is set — retrieval is keyword-only for now.");
}

main().catch((e) => {
  console.error("✖ ingest-knowledge failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
