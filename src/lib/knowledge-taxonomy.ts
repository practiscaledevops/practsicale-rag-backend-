// Shared taxonomy for classifying knowledge at ingest: categories, access levels,
// and departments. Used by the upload flow (to tag documents) and surfaced on the
// Documents table. Pure data — safe to import from client or server.

export const CATEGORIES = [
  "CEO mindset / principles",
  "Sales calls",
  "Call scores",
  "Sales objections",
  "Copywriting",
  "Campaign learnings",
  "Media strategy",
  "SOPs",
  "Product knowledge",
  "Case studies",
  "Customer research",
  "Competitor intelligence",
  "Internal announcements",
  "Restricted executive knowledge",
] as const;

export interface AccessLevel {
  value: string;
  label: string;
  /** Rough hint of who can retrieve it (informational in the UI). */
  scope: string;
}

export const ACCESS_LEVELS: AccessLevel[] = [
  { value: "team", label: "Team", scope: "All employees" },
  { value: "restricted", label: "Restricted", scope: "Named roles / keys" },
  { value: "confidential", label: "Confidential", scope: "Leadership" },
  { value: "ceo_only", label: "CEO only", scope: "Executive" },
  { value: "public", label: "Public", scope: "Client-facing OK" },
];

export const DEPARTMENTS = [
  "Leadership",
  "Sales",
  "Marketing",
  "Media",
  "Operations",
  "Product",
  "Customer Success",
] as const;
