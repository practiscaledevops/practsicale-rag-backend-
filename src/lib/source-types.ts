// The documents.source_type registry: every kind of data the Brain stores and
// retrieves, with its sensitivity. Pure data, safe for client and server.
//
// ADD A NEW SOURCE TYPE HERE (and in the documents / data_sources CHECK
// constraints, supabase/migrations/0001 + 0006). The capability manifest
// (src/lib/capability-manifest.ts) is built from this list, so a type added here
// shows up in every consumer app's permission editor as "data.<id>" without a
// change on their side.
//
// Sensitive types carry raw call material (AI call-scoring results, QA
// transcripts, coaching notes): consumer apps keep them OFF for ordinary team
// members by default, and the Brain map hides objects built from them unless a
// key's scope allows them (see keyAllowsSensitive in src/lib/knowledge-read.ts,
// which test/capability-manifest.test.ts keeps in agreement with this list).

export interface SourceTypeDef {
  /** documents.source_type value (stable; used in key scopes and retrieval filters). */
  id: string;
  label: string;
  /** One line, written for an admin deciding who may see it. */
  description: string;
  /** Raw call material / personal data — default OFF for team members in consumer apps. */
  sensitive: boolean;
}

export const SOURCE_TYPE_DEFS: readonly SourceTypeDef[] = [
  {
    id: "document",
    label: "Company knowledge",
    description: "SOPs, offers, brand and playbooks, uploaded documents and compiled knowledge.",
    sensitive: false,
  },
  {
    id: "call_score",
    label: "AI call scores",
    description: "Call-scoring results per call: scores, bands, outcomes, phase scores, consultants.",
    sensitive: true,
  },
  {
    id: "transcript",
    label: "Call transcripts (QA)",
    description: "Full sales-call transcripts from the scoring app, quoted word for word with timestamps.",
    sensitive: true,
  },
  {
    id: "coaching",
    label: "Coaching notes",
    description: "Coaching recommendations and QA feedback written about individual calls.",
    sensitive: true,
  },
];

export const SOURCE_TYPE_IDS: readonly string[] = SOURCE_TYPE_DEFS.map((s) => s.id);

/** The sensitive source types (raw call material). */
export const SENSITIVE_SOURCE_TYPE_IDS: readonly string[] = SOURCE_TYPE_DEFS.filter((s) => s.sensitive).map((s) => s.id);

export function isSourceType(v: unknown): boolean {
  return typeof v === "string" && SOURCE_TYPE_IDS.includes(v);
}
