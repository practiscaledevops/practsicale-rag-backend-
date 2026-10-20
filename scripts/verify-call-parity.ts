// Read-only, exhaustive source/document/chunk audit. No names, transcripts or keys
// are written to the report. Run: npx tsx scripts/verify-call-parity.ts
import { loadEnvConfig } from "@next/env";
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { serializeRecord } from "../src/lib/chunking";
import { redactPII } from "../src/lib/redact";
loadEnvConfig(process.cwd());
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const status = (v: unknown) => typeof v === "string" && v.trim() ? v.trim().toLowerCase() : "pending";
const ticket = (v: unknown) => typeof v === "string" && v.trim() ? v.trim().toLowerCase() : "unclassified";
const revision = (v: unknown) => v ? Date.parse(String(v)) : null;
const outcome = (v: unknown) => typeof v === "string" && v.trim() ? v.trim().toUpperCase() : "UNKNOWN";
const sequence = (v: unknown) => Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null;
const hash = (text: string) => createHash("sha256").update(redactPII(text)).digest("hex");
// Independently reconstruct the source bodies. Matching revisions alone cannot
// establish that a historical report/transcript was actually refreshed.
function expectedHashes(raw: Record<string, unknown>): Record<string, string> {
  const { transcript, ...r } = raw;
  const crm = ({ closed: "Closed", not_closed: "Not Closed", pending: "Pending", disqualified: "Disqualified" } as Record<string, string>)[status(r.call_status)] ?? status(r.call_status);
  const closing = r.ticket_category === "high_ticket" ? "High Ticket" : r.ticket_category === "low_ticket" ? "Low Ticket" : "Unclassified";
  const hashes: Record<string, string> = { call_score: hash(`Current CRM status: ${crm}\nClosing type: ${closing}\nThe call_outcome in the original report is historical, not current CRM truth.\n\n${serializeRecord(r)}`) };
  const str = (v: unknown) => String(v ?? "").trim();
  if (typeof transcript === "string" && transcript.trim()) {
    const consultant = str(r.consultant_name) || str(r.consultant) || "Unknown consultant";
    const prospect = str(r.prospect_name) || "Unknown prospect";
    const date = str(r.call_date) || str(r.created_at);
    const score = str(r.overall_score), band = str(r.performance_band);
    const recording = Array.isArray(r.recording_links) ? r.recording_links.find(v => typeof v === "string" && v.trim()) : r.recording_links;
    const header = [`Call transcript — ${consultant} → ${prospect}`, `Consultant: ${consultant}`, `Prospect: ${prospect}`,
      str(r.practice_type) ? `Practice type: ${str(r.practice_type)}` : "", date ? `Call date: ${date}` : "",
      `Current CRM status: ${crm}`, `Closing type: ${closing}`,
      str(r.call_outcome) ? `Model's original outcome (not current CRM status): ${str(r.call_outcome)}` : "",
      score ? `Score: ${score}/100${band ? ` (${band})` : ""}` : band ? `Band: ${band}` : "",
      str(r.call_duration_minutes) ? `Duration: ${str(r.call_duration_minutes)} min` : "", str(recording) ? `Recording: ${str(recording)}` : "",
    ].filter(Boolean).join("\n");
    hashes.transcript = hash(`${header}\n\n${transcript.trim()}`);
  }
  return hashes;
}
type SourceRecord = { id: string; status: string; ticket: string; outcome: string; sequence: number | null; revision: unknown; hasTranscript: boolean; hashes: Record<string, string> };
type Issue = { recordId?: string; documentId?: string; chunkId?: string; type: string; expected?: unknown; actual?: unknown };

async function main() {
  const started = new Date().toISOString();
  const { data: sources, error } = await db.from("data_sources").select("*").eq("source_type", "call_score").eq("is_active", true);
  if (error) throw Error(error.message);
  const audits = [];
  for (const source of sources ?? []) {
    const records = new Map<string, SourceRecord>();
    for (let offset = 0; ; offset += 25) {
      const url = new URL(source.endpoint_url);
      // Creation order is immutable; updates cannot move a row behind an offset.
      url.searchParams.set("since", "1970-01-01T00:00:00.000Z");
      url.searchParams.set("include_transcript", "true");
      url.searchParams.set("limit", "25"); url.searchParams.set("offset", String(offset));
      const response = await fetch(url, { headers: { "x-api-key": process.env[source.auth_secret_ref] ?? "" }, redirect: "manual", signal: AbortSignal.timeout(45_000) });
      if (!response.ok) throw Error(`Scoring feed HTTP ${response.status}`);
      const json = await response.json();
      const rows = (source.records_path ? source.records_path.split(".").reduce((o: any, k: string) => o?.[k], json) : json) as Record<string, unknown>[];
      if (!Array.isArray(rows)) throw Error("Scoring feed records are not an array");
      for (const r of rows) records.set(String(r[source.record_id_field ?? "id"]), { id: String(r[source.record_id_field ?? "id"]), status: status(r.call_status), ticket: ticket(r.ticket_category), outcome: outcome(r.call_outcome), sequence: sequence(r.call_sequence), revision: r.updated_at, hasTranscript: typeof r.transcript === "string" && !!r.transcript.trim(), hashes: expectedHashes(r) });
      if (rows.length < 25) break;
      if (offset > 100_000) throw Error("Source pagination safety limit exceeded");
    }
    const issues: Issue[] = [];
    const documents: any[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db.from("documents").select("id,source_type,content_hash,metadata").eq("org_id", source.org_id).eq("data_source_id", source.id).order("id").range(offset, offset + 999);
      if (error) throw Error(error.message);
      documents.push(...data); if (data.length < 1000) break;
    }
    const grouped = new Map<string, any[]>();
    const docRecords = new Map<string, SourceRecord>();
    const docChunkCounts = new Map<string, number>();
    const totals: Record<string, number> = {};
    let revisionLag = 0;
    for (const r of records.values()) totals[`${r.status}/${r.ticket}`] = (totals[`${r.status}/${r.ticket}`] ?? 0) + 1;
    for (const d of documents) {
      const id = String(d.metadata?.source_record_id ?? "");
      const r = records.get(id);
      if (!r) { issues.push({ documentId: d.id, type: "orphan_source_identity" }); continue; }
      const key = `${d.source_type}:${id}`;
      grouped.set(key, [...(grouped.get(key) ?? []), d]);
      docRecords.set(d.id, r);
      if (status(d.metadata.call_status) !== r.status) issues.push({ recordId: id, documentId: d.id, type: "document_status", expected: r.status, actual: status(d.metadata.call_status) });
      if (ticket(d.metadata.ticket_category) !== r.ticket) issues.push({ recordId: id, documentId: d.id, type: "document_ticket", expected: r.ticket, actual: ticket(d.metadata.ticket_category) });
      if (outcome(d.metadata.call_outcome) !== r.outcome) issues.push({ recordId: id, documentId: d.id, type: "document_original_outcome", expected: r.outcome, actual: outcome(d.metadata.call_outcome) });
      if (sequence(d.metadata.call_sequence) !== r.sequence) issues.push({ recordId: id, documentId: d.id, type: "document_sequence", expected: r.sequence, actual: sequence(d.metadata.call_sequence) });
      if (d.content_hash !== r.hashes[d.source_type]) issues.push({ recordId: id, documentId: d.id, type: "document_body_hash" });
      if (revision(d.metadata.source_body_updated_at ?? d.metadata.source_updated_at) !== revision(r.revision)) revisionLag++;
    }
    for (const r of records.values()) {
      for (const type of r.hasTranscript ? ["call_score", "transcript"] : ["call_score"]) {
        const matches = grouped.get(`${type}:${r.id}`) ?? [];
        if (matches.length !== 1) issues.push({ recordId: r.id, type: matches.length ? `duplicate_${type}` : `missing_${type}`, actual: matches.length });
      }
    }
    let chunkCount = 0;
    let chunkRevisionLag = 0;
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db.from("chunks")
        .select("id,document_id,status:metadata->>call_status,ticket:metadata->>ticket_category,revision:metadata->>source_updated_at,body_revision:metadata->>source_body_updated_at,outcome:metadata->>call_outcome,sequence:metadata->>call_sequence")
        .eq("org_id", source.org_id).eq("data_source_id", source.id).order("id").range(offset, offset + 999);
      if (error) throw Error(error.message);
      for (const c of data) {
        chunkCount++;
        const r = docRecords.get(c.document_id); if (!r) continue;
        docChunkCounts.set(c.document_id, (docChunkCounts.get(c.document_id) ?? 0) + 1);
        if (status(c.status) !== r.status) issues.push({ recordId: r.id, documentId: c.document_id, chunkId: c.id, type: "chunk_status", expected: r.status, actual: status(c.status) });
        if (ticket(c.ticket) !== r.ticket) issues.push({ recordId: r.id, documentId: c.document_id, chunkId: c.id, type: "chunk_ticket", expected: r.ticket, actual: ticket(c.ticket) });
        if (outcome(c.outcome) !== r.outcome) issues.push({ recordId: r.id, documentId: c.document_id, chunkId: c.id, type: "chunk_original_outcome", expected: r.outcome, actual: outcome(c.outcome) });
        if (sequence(c.sequence) !== r.sequence) issues.push({ recordId: r.id, documentId: c.document_id, chunkId: c.id, type: "chunk_sequence", expected: r.sequence, actual: sequence(c.sequence) });
        if (revision(c.body_revision ?? c.revision) !== revision(r.revision)) chunkRevisionLag++;
      }
      if (data.length < 1000) break;
    }
    for (const d of documents) if (docRecords.has(d.id) && !docChunkCounts.has(d.id)) issues.push({ recordId: docRecords.get(d.id)!.id, documentId: d.id, type: "missing_chunks" });
    const embeddings = await db.from("chunks").select("id", { count: "exact", head: true }).eq("org_id", source.org_id).eq("data_source_id", source.id).is("embedding", null);
    if (embeddings.error) throw Error(embeddings.error.message);
    if (embeddings.count) issues.push({ type: "missing_embeddings", actual: embeddings.count });
    const queue: Record<string, unknown> = {};
    for (const state of ["pending", "running", "completed"]) {
      const { count, error } = await db.from("scoring_sync_events").select("id", { count: "exact", head: true }).eq("org_id", source.org_id).eq("data_source_id", source.id).eq("status", state);
      if (error) throw Error(error.message); queue[state] = count;
    }
    const { data: failures, error: failureError } = await db.from("scoring_sync_events").select("id,record_id,status,attempts,last_error,next_attempt_at").eq("org_id", source.org_id).eq("data_source_id", source.id).not("last_error", "is", null).limit(20);
    if (failureError) throw Error(failureError.message);
    const issueCounts = issues.reduce<Record<string, number>>((a, i) => { a[i.type] = (a[i.type] ?? 0) + 1; return a; }, {});
    const followUps = [...records.values()].filter(r => r.outcome === "FOLLOW_UP").length;
    const followUpConversations = [...records.values()].filter(r => r.sequence != null && r.sequence > 1).length;
    const unknownSequence = [...records.values()].filter(r => r.sequence == null).length;
    const complete = !issues.length && !revisionLag && !chunkRevisionLag && !queue.pending && !queue.running && !failures?.length;
    const result = { sourceId: source.id, calls: records.size, withTranscript: [...records.values()].filter(r => r.hasTranscript).length, documents: documents.length, chunks: chunkCount, totals, followUps, followUpConversations, unknownSequence, complete, issueCounts, affectedCalls: new Set(issues.map(i => i.recordId).filter(Boolean)).size, documentsAwaitingRevision: revisionLag, chunksAwaitingRevision: chunkRevisionLag, queue, failures, issues };
    audits.push(result);
    console.log(JSON.stringify({ ...result, issues: undefined }));
  }
  const directory = resolve("../verification"); mkdirSync(directory, { recursive: true });
  const path = resolve(directory, `call-parity-${started.replace(/[:.]/g, "-")}.json`);
  writeFileSync(path, JSON.stringify({ startedAt: started, finishedAt: new Date().toISOString(), audits }, null, 2));
  console.log(JSON.stringify({ report: path }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
