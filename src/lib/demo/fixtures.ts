// In-memory demo data for DEMO MODE. Seeds a single demo org with representative
// rows for every table the dashboard reads, so each screen shows something real.
//
// The store is a module-level singleton: mutations (create key, add source, etc.)
// persist for the life of the dev server process, so demos feel live.

import type { AdminSession } from "@/lib/auth/session";

export const DEMO_ORG_ID = "00000000-0000-0000-0000-0000000000d0";
export const DEMO_USER_ID = "00000000-0000-0000-0000-0000000000a1";

export const DEMO_ADMIN: AdminSession = {
  userId: DEMO_USER_ID,
  orgId: DEMO_ORG_ID,
  email: "demo@practiscale.co",
  role: "super_admin",
  permissions: {
    data_sources: ["read", "write"],
    prompts: ["read", "write"],
    api_keys: ["read", "write", "revoke"],
    connectors: ["read", "write"],
    members: ["read", "write"],
    analytics: ["read"],
    documents: ["read", "write"],
  },
  memberId: "demo-member-1",
};

type Row = Record<string, any>;
export type Store = Record<string, Row[]>;

const iso = (daysAgo: number, hour = 12) => {
  // Deterministic timestamps relative to a fixed anchor so the UI is stable.
  const anchor = new Date("2026-07-29T00:00:00Z").getTime();
  return new Date(anchor - daysAgo * 86400000 + hour * 3600000).toISOString();
};

function seed(): Store {
  const org = DEMO_ORG_ID;

  const documents: Row[] = [
    { id: "doc-1", org_id: org, source_type: "call_score", title: "Call scores — week 30", uri: "pull://call-scoring/week30", content_hash: "h1", data_source_id: "src-1", metadata: { records: 128 }, created_at: iso(2), updated_at: iso(2) },
    { id: "doc-2", org_id: org, source_type: "coaching", title: "Coaching notes — discovery", uri: "upload://coaching-discovery.md", content_hash: "h2", data_source_id: null, metadata: {}, created_at: iso(5), updated_at: iso(5) },
    { id: "doc-3", org_id: org, source_type: "document", title: "NEMT sales playbook.md", uri: "upload://nemt-playbook.md", content_hash: "h3", data_source_id: null, metadata: { sections: 9 }, created_at: iso(8), updated_at: iso(8) },
    { id: "doc-4", org_id: org, source_type: "call_score", title: "Call scores — week 29", uri: "pull://call-scoring/week29", content_hash: "h4", data_source_id: "src-1", metadata: { records: 141 }, created_at: iso(9), updated_at: iso(9) },
    { id: "doc-5", org_id: org, source_type: "document", title: "Objection handling guide.md", uri: "upload://objections.md", content_hash: "h5", data_source_id: null, metadata: { sections: 6 }, created_at: iso(12), updated_at: iso(12) },
  ];

  const chunks: Row[] = [
    { id: "demo-chunk-1", org_id: org, document_id: "doc-1", parent_id: null, content: "Call 4821 scored 84/100; strong on closing, weak on discovery; recommendation: ask more open discovery questions before pitching.", source_type: "call_score", data_source_id: "src-1", collection_ids: ["col-1"], metadata: {}, created_at: iso(2) },
    { id: "demo-chunk-2", org_id: org, document_id: "doc-2", parent_id: null, content: "Coaching: reps who mirror the customer's stated priority in the first two minutes close 23% more often.", source_type: "coaching", data_source_id: null, collection_ids: ["col-1"], metadata: {}, created_at: iso(5) },
    { id: "demo-chunk-3", org_id: org, document_id: "doc-3", parent_id: null, content: "NEMT playbook: lead with reliability and on-time performance; price is secondary for facility coordinators.", source_type: "document", data_source_id: null, collection_ids: ["col-2"], metadata: {}, created_at: iso(8) },
  ];

  const data_sources: Row[] = [
    { id: "src-1", org_id: org, name: "Call-scoring feed", slug: "call-scoring", source_type: "call_score", kind: "pull_http", endpoint_url: "https://scoring.internal.practiscale.co/api/scores", http_method: "GET", auth_type: "bearer", auth_secret_ref: "CALL_SCORING_TOKEN", headers: {}, query_params: {}, records_path: "data", record_id_field: "call_id", cursor_field: "scored_at", cursor_value: iso(2), schedule_cron: "0 * * * *", is_active: true, last_run_at: iso(0, 6), last_status: "success", created_by: "demo-member-1", created_at: iso(20), updated_at: iso(0, 6) },
    { id: "src-2", org_id: org, name: "Coaching exports", slug: "coaching", source_type: "coaching", kind: "pull_http", endpoint_url: "https://coaching.internal.practiscale.co/api/notes", http_method: "GET", auth_type: "api_key", auth_secret_ref: "COACHING_KEY", headers: {}, query_params: {}, records_path: "results", record_id_field: "id", cursor_field: "updated_at", cursor_value: iso(5), schedule_cron: null, is_active: true, last_run_at: iso(5, 9), last_status: "success", created_by: "demo-member-1", created_at: iso(18), updated_at: iso(5, 9) },
  ];

  const ingestion_runs: Row[] = [
    { id: "run-1", org_id: org, data_source_id: "src-1", trigger: "schedule", status: "success", documents_ingested: 1, chunks_ingested: 128, documents_skipped: 0, error: null, started_at: iso(0, 6), finished_at: iso(0, 6) },
    { id: "run-2", org_id: org, data_source_id: "src-1", trigger: "schedule", status: "success", documents_ingested: 1, chunks_ingested: 141, documents_skipped: 0, error: null, started_at: iso(1, 6), finished_at: iso(1, 6) },
    { id: "run-3", org_id: org, data_source_id: "src-2", trigger: "manual", status: "error", documents_ingested: 0, chunks_ingested: 0, documents_skipped: 0, error: "401 from source endpoint (check COACHING_KEY)", started_at: iso(3, 10), finished_at: iso(3, 10) },
  ];

  const api_keys: Row[] = [
    { id: "key-1", org_id: org, name: "NEMT chatbot (prod)", key_prefix: "psk_live_a1b2c3d4", key_hash: "x", source_types: ["call_score", "coaching"], capabilities: ["chat"], data_source_ids: [], collection_ids: [], rate_limit_per_min: 60, expires_at: null, revoked_at: null, created_by: "demo-member-1", request_count: 3894, last_used_at: iso(0, 8), created_at: iso(15) },
    { id: "key-2", org_id: org, name: "Analytics exporter", key_prefix: "psk_live_9f8e7d6c", key_hash: "y", source_types: ["call_score"], capabilities: ["retrieve"], data_source_ids: ["src-1"], collection_ids: [], rate_limit_per_min: 30, expires_at: null, revoked_at: null, created_by: "demo-member-1", request_count: 512, last_used_at: iso(1, 14), created_at: iso(10) },
    { id: "key-3", org_id: org, name: "Old test key", key_prefix: "psk_test_11223344", key_hash: "z", source_types: ["document"], capabilities: ["chat", "retrieve"], data_source_ids: [], collection_ids: [], rate_limit_per_min: 60, expires_at: null, revoked_at: iso(4), created_by: "demo-member-1", request_count: 27, last_used_at: iso(6), created_at: iso(30) },
  ];

  const prompts: Row[] = [
    { id: "pr-1", org_id: org, use_case: "chat", version: 2, content: "You are Practiscale's knowledge assistant. Answer ONLY from the provided context. Cite chunk ids as [id]. Say you don't know if unsupported.", is_active: true, created_at: iso(6) },
    { id: "pr-2", org_id: org, use_case: "chat", version: 1, content: "You are a helpful assistant grounded in Practiscale data.", is_active: false, created_at: iso(20) },
    { id: "pr-3", org_id: org, use_case: "script", version: 1, content: "Write a short video script grounded in the provided context. Use Practiscale's brand voice.", is_active: true, created_at: iso(14) },
  ];

  const connectors: Row[] = [
    { id: "con-1", org_id: org, name: "Higgsfield image API", slug: "higgsfield", kind: "http_api", config: { base_url: "https://api.higgsfield.ai" }, auth_secret_ref: "HIGGSFIELD_KEY", is_active: true, created_by: "demo-member-1", created_at: iso(7) },
    { id: "con-2", org_id: org, name: "Docs MCP server", slug: "docs-mcp", kind: "mcp", config: { server_url: "https://mcp.internal.practiscale.co", transport: "sse" }, auth_secret_ref: "DOCS_MCP_TOKEN", is_active: true, created_by: "demo-member-1", created_at: iso(9) },
  ];

  const connector_grants: Row[] = [
    { id: "cg-1", org_id: org, connector_id: "con-1", api_key_id: "key-1", created_at: iso(6) },
  ];

  const collections: Row[] = [
    { id: "col-1", org_id: org, name: "Sales calls", slug: "sales-calls", description: "Call scores + coaching", created_by: "demo-member-1", created_at: iso(16) },
    { id: "col-2", org_id: org, name: "Playbooks", slug: "playbooks", description: "Reference documents", created_by: "demo-member-1", created_at: iso(16) },
  ];

  const document_collections: Row[] = [
    { org_id: org, document_id: "doc-1", collection_id: "col-1" },
    { org_id: org, document_id: "doc-2", collection_id: "col-1" },
    { org_id: org, document_id: "doc-3", collection_id: "col-2" },
  ];

  const org_members: Row[] = [
    { id: "demo-member-1", org_id: org, user_id: DEMO_USER_ID, email: "demo@practiscale.co", role: "super_admin", permissions: DEMO_ADMIN.permissions, is_active: true, created_by: null, created_at: iso(40) },
    { id: "demo-member-2", org_id: org, user_id: "u-2", email: "aisha@practiscale.co", role: "admin", permissions: { data_sources: ["read", "write"], prompts: ["read", "write"] }, is_active: true, created_by: "demo-member-1", created_at: iso(12) },
    { id: "demo-member-3", org_id: org, user_id: "u-3", email: "omar@practiscale.co", role: "admin", permissions: { api_keys: ["read"], analytics: ["read"] }, is_active: true, created_by: "demo-member-1", created_at: iso(3) },
  ];

  // Usage events across 14 days for the analytics charts.
  const models = [
    { model: "claude-haiku-4-5", tier: "fast" },
    { model: "claude-sonnet-4-6", tier: "recommended" },
    { model: "claude-opus-4-8", tier: "max" },
  ];
  const usage_events: Row[] = [];
  let u = 0;
  for (let d = 13; d >= 0; d--) {
    const perDay = 40 + ((d * 7) % 25);
    for (let i = 0; i < perDay; i++) {
      const m = models[(d + i) % 3];
      const inTok = 800 + ((i * 37) % 1200);
      const outTok = 150 + ((i * 19) % 500);
      usage_events.push({
        id: `ue-${u++}`,
        org_id: org,
        api_key_id: i % 4 === 0 ? "key-2" : "key-1",
        user_id: null,
        kind: i % 5 === 0 ? "retrieve" : "chat",
        model: m.model,
        tier: m.tier,
        input_tokens: inTok,
        output_tokens: outTok,
        cost_usd: Number((inTok * 0.000003 + outTok * 0.000015).toFixed(6)),
        latency_ms: 600 + ((i * 13) % 1400),
        cached: i % 3 === 0,
        created_at: iso(d, (i % 12) + 6),
      });
    }
  }

  return {
    documents,
    chunks,
    data_sources,
    ingestion_runs,
    api_keys,
    prompts,
    connectors,
    connector_grants,
    collections,
    document_collections,
    org_members,
    usage_events,
  };
}

// Module-level singleton so mutations persist across requests in dev.
let _store: Store | null = null;
export function demoStore(): Store {
  if (!_store) _store = seed();
  return _store;
}
