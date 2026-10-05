"use client";

// The knowledge approval queue.
//
//   - An APPROVER (super_admin / documents:approve) sees every submission in the org
//     and can approve (replay the commit → it goes live) or reject (with a note).
//   - A plain uploader sees ONLY their own submissions, read-only, with the reviewer's
//     note — so they can tell what is live, pending, or was sent back.
//
// Both views are filtered by status. Approve is heavy (it replays compileKnowledge /
// ingestOne server-side), so bulk approve is a bounded POOL over the single-item
// endpoint; bulk reject is one set-based request. The approve/reject POST route
// enforces documents:approve on every call — these controls are a convenience.

import * as React from "react";
import Link from "next/link";
import { Check, Eye, ShieldCheck, X } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  FilterTabs,
  RelTime,
  Spinner,
  Table,
  TableCard,
  TableEmptyRow,
  TBody,
  Td,
  Textarea,
  Th,
  THead,
  Tr,
  ClassBadge,
  BulkActionBar,
  RowSelectCell,
  SelectAllCell,
  useBulkRun,
  usePendingIds,
  useSelection,
  type BadgeTone,
} from "@/components/ui";
import { requestJson, BULK_CONCURRENCY, type BulkResult } from "@/lib/bulk";
import { statusLabel } from "@/lib/ui-labels";
import { humanize } from "@/lib/format";
import { cn } from "@/lib/utils";

const ENDPOINT = "/api/admin/knowledge/submissions";

type SubStatus = "pending" | "approved" | "rejected";

interface PreviewDraft {
  name?: string;
  summary?: string;
  compiled_markdown?: string;
  teaching_core?: string;
  sections?: { heading: string; body: string }[];
}
interface SubmissionPreview {
  draft?: PreviewDraft;
  warnings?: string[];
}

interface Submission {
  id: string;
  submitted_by: string | null;
  submitted_by_email: string;
  title: string | null;
  kind: string;
  commit_via: string;
  source_type: string | null;
  intelligence_class: string | null;
  bucket: string | null;
  preview: SubmissionPreview | null;
  status: SubStatus;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  committed_object_id: string | null;
  created_at: string;
}

interface ListResponse {
  items: Submission[];
  counts: Record<SubStatus, number>;
  canApprove: boolean;
}

const STATUS_TONE: Record<SubStatus, BadgeTone> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
};

const TITLE_OF = (s: Submission): string => s.preview?.draft?.name || s.title || "(untitled)";

export function ApprovalsClient({ canApprove }: { canApprove: boolean }) {
  const [tab, setTab] = React.useState<SubStatus>("pending");
  const [items, setItems] = React.useState<Submission[]>([]);
  const [counts, setCounts] = React.useState<Record<SubStatus, number>>({ pending: 0, approved: 0, rejected: 0 });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [previewItem, setPreviewItem] = React.useState<Submission | null>(null);
  const [rejectState, setRejectState] = React.useState<{ ids: string[]; bulk: boolean } | null>(null);
  const [rejectNote, setRejectNote] = React.useState("");
  const [rejecting, setRejecting] = React.useState(false);
  const [rejectError, setRejectError] = React.useState<string | null>(null);

  const pending = usePendingIds();
  const bulk = useBulkRun();

  const load = React.useCallback(async (status: SubStatus) => {
    setLoading(true);
    setError(null);
    try {
      const data = await requestJson<ListResponse>(`${ENDPOINT}?status=${status}`);
      setItems(data.items ?? []);
      setCounts(data.counts ?? { pending: 0, approved: 0, rejected: 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load submissions");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load(tab);
  }, [tab, load]);

  const reload = React.useCallback(() => load(tab), [load, tab]);

  // Only pending rows can be acted on, and only by an approver.
  const selectableIds = canApprove && tab === "pending" ? items.map((i) => i.id) : [];
  const sel = useSelection(selectableIds);

  const approveOne = React.useCallback(
    async (id: string) => {
      await pending.run(id, async () => {
        try {
          await requestJson(ENDPOINT, { method: "POST", json: { id, action: "approve" } });
          await reload();
        } catch (e) {
          setError(e instanceof Error ? e.message : "Approve failed");
        }
      });
    },
    [pending, reload]
  );

  const approveSelected = React.useCallback(() => {
    const ids = sel.selectedIds;
    if (ids.length === 0) return;
    void bulk.run(ids, (id, signal) => requestJson(ENDPOINT, { method: "POST", json: { id, action: "approve" }, signal }), {
      concurrency: BULK_CONCURRENCY.llm,
      verbs: { running: "Approving", done: "approved" },
      onSettled: async (r: BulkResult<string>) => {
        sel.settle(r);
        await reload();
      },
    });
  }, [sel, bulk, reload]);

  const openReject = (id: string) => {
    setRejectNote("");
    setRejectError(null);
    setRejectState({ ids: [id], bulk: false });
  };
  const openBulkReject = () => {
    if (sel.selectedIds.length === 0) return;
    setRejectNote("");
    setRejectError(null);
    setRejectState({ ids: sel.selectedIds, bulk: true });
  };
  const closeReject = () => {
    if (rejecting) return;
    setRejectState(null);
    setRejectNote("");
    setRejectError(null);
  };

  const confirmReject = React.useCallback(async () => {
    if (!rejectState) return;
    const note = rejectNote.trim();
    if (rejectState.bulk) {
      const ids = rejectState.ids;
      setRejectState(null);
      await bulk.runChunks(
        ids,
        async (batch, signal) => {
          const r = await requestJson<{ ids: string[] }>(ENDPOINT, {
            method: "POST",
            json: { ids: batch, action: "reject", note },
            signal,
          });
          return { ok: r.ids ?? [] };
        },
        {
          verbs: { running: "Rejecting", done: "rejected" },
          onSettled: async (r: BulkResult<string>) => {
            sel.settle(r);
            await reload();
          },
        }
      );
      return;
    }
    const id = rejectState.ids[0];
    setRejecting(true);
    setRejectError(null);
    try {
      await requestJson(ENDPOINT, { method: "POST", json: { id, action: "reject", note } });
      setRejectState(null);
      setRejectNote("");
      await reload();
    } catch (e) {
      setRejectError(e instanceof Error ? e.message : "Reject failed");
    } finally {
      setRejecting(false);
    }
  }, [rejectState, rejectNote, bulk, sel, reload]);

  const tabs = [
    { id: "pending" as const, label: "Pending", count: counts.pending },
    { id: "approved" as const, label: "Approved", count: counts.approved },
    { id: "rejected" as const, label: "Rejected", count: counts.rejected },
  ];

  const colCount = canApprove && tab === "pending" ? 6 : 5;
  const rowBusy = (id: string) => pending.isPending(id) || bulk.isActive(id);

  const emptyCopy =
    tab === "pending"
      ? canApprove
        ? "No knowledge is waiting for review."
        : "You have no knowledge waiting for review."
      : canApprove
      ? `No ${tab} submissions.`
      : `None of your submissions are ${tab}.`;

  return (
    <div className="space-y-4">
      <FilterTabs label="Filter submissions by status" value={tab} tabs={tabs} onChange={(id) => setTab(id)} />

      {error && <Alert tone="danger">{error}</Alert>}

      <TableCard
        title={canApprove ? "Submissions" : "My submissions"}
        meta={loading ? "Loading…" : `${items.length} shown`}
      >
        <Table minWidth={720}>
          <THead>
            <Tr>
              {canApprove && tab === "pending" && <SelectAllCell {...sel.selectAllProps} label="Select all pending submissions" />}
              <Th>Submission</Th>
              <Th>Class</Th>
              <Th>Submitted</Th>
              {tab === "pending" ? <Th>Submitter</Th> : <Th>Review</Th>}
              <Th className="w-px text-right">{tab === "pending" && canApprove ? "Actions" : ""}</Th>
            </Tr>
          </THead>
          <TBody>
            {loading ? (
              <TableEmptyRow colSpan={colCount}>
                <span className="inline-flex items-center gap-2">
                  <Spinner /> Loading…
                </span>
              </TableEmptyRow>
            ) : items.length === 0 ? (
              <TableEmptyRow colSpan={colCount}>
                <EmptyState icon={ShieldCheck} title={emptyCopy} />
              </TableEmptyRow>
            ) : (
              items.map((s) => {
                const busy = rowBusy(s.id);
                return (
                  <Tr key={s.id} data-row-id={s.id} className={cn(sel.isSelected(s.id) && "bg-accent-soft")}>
                    {canApprove && tab === "pending" && (
                      <RowSelectCell {...sel.rowProps(s.id)} disabled={busy} label={`Select ${TITLE_OF(s)}`} />
                    )}
                    <Td>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium text-foreground">{TITLE_OF(s)}</span>
                          <Badge tone="neutral">{humanize(s.kind)}</Badge>
                        </div>
                        {s.preview?.draft?.summary && (
                          <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{s.preview.draft.summary}</p>
                        )}
                      </div>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-1">
                        {s.intelligence_class ? <ClassBadge klass={s.intelligence_class} /> : <span className="text-xs text-muted-foreground">—</span>}
                        {s.bucket && <Badge tone="neutral">{humanize(s.bucket)}</Badge>}
                      </div>
                    </Td>
                    <Td className="whitespace-nowrap text-muted-foreground">
                      <RelTime iso={s.created_at} />
                    </Td>
                    {tab === "pending" ? (
                      <Td className="truncate text-muted-foreground">{s.submitted_by_email}</Td>
                    ) : (
                      <Td>
                        <div className="min-w-0">
                          <Badge tone={STATUS_TONE[s.status]}>{statusLabel(s.status)}</Badge>
                          {s.review_note && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{s.review_note}</p>}
                        </div>
                      </Td>
                    )}
                    <Td className="text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button size="sm" variant="ghost" onClick={() => setPreviewItem(s)}>
                          <Eye size={14} aria-hidden /> Preview
                        </Button>
                        {canApprove && tab === "pending" && (
                          <>
                            <Button
                              size="sm"
                              variant="primary"
                              data-focus="approve"
                              loading={busy}
                              disabled={busy}
                              onClick={() => void approveOne(s.id)}
                            >
                              <Check size={14} aria-hidden /> Approve
                            </Button>
                            <Button size="sm" variant="danger-secondary" disabled={busy} onClick={() => openReject(s.id)}>
                              <X size={14} aria-hidden /> Reject
                            </Button>
                          </>
                        )}
                      </div>
                    </Td>
                  </Tr>
                );
              })
            )}
          </TBody>
        </Table>
      </TableCard>

      {canApprove && tab === "pending" && (
        <BulkActionBar
          count={sel.count}
          onClear={sel.clear}
          run={bulk}
          noun={["submission", "submissions"]}
          actions={[
            { key: "approve", label: "Approve", icon: Check, tone: "primary", onClick: approveSelected },
            { key: "reject", label: "Reject", icon: X, tone: "danger", onClick: openBulkReject },
          ]}
        />
      )}

      {/* Preview: what will go live if approved. */}
      <Dialog
        open={previewItem !== null}
        onClose={() => setPreviewItem(null)}
        title={previewItem ? TITLE_OF(previewItem) : "Preview"}
        description={previewItem ? `Submitted by ${previewItem.submitted_by_email}` : undefined}
        size="lg"
      >
        {previewItem && <PreviewBody item={previewItem} />}
      </Dialog>

      {/* Reject, with an optional note kept on the submission for the audit. */}
      <ConfirmDialog
        open={rejectState !== null}
        title={rejectState?.bulk ? `Reject ${rejectState.ids.length} submission${rejectState.ids.length === 1 ? "" : "s"}?` : "Reject submission?"}
        description="The submitter keeps the record and your note; nothing is ingested."
        confirmLabel="Reject"
        tone="danger"
        busy={rejecting || (rejectState?.bulk ? bulk.running : false)}
        error={rejectError}
        onCancel={closeReject}
        onConfirm={() => void confirmReject()}
      >
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-foreground">Note to the submitter (optional)</span>
          <Textarea
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            rows={3}
            placeholder="Why is this being sent back?"
          />
        </label>
      </ConfirmDialog>
    </div>
  );
}

/** The compiled proposal (or a note for file uploads, which have no AI proposal). */
function PreviewBody({ item }: { item: Submission }) {
  const draft = item.preview?.draft;
  const body = draft?.compiled_markdown || draft?.teaching_core || "";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="neutral">{humanize(item.kind)}</Badge>
        {item.intelligence_class && <ClassBadge klass={item.intelligence_class} />}
        {item.bucket && <Badge tone="neutral">{humanize(item.bucket)}</Badge>}
      </div>
      {draft?.summary && <p className="text-[13px] text-foreground">{draft.summary}</p>}
      {item.preview?.warnings && item.preview.warnings.length > 0 && (
        <Alert tone="warning">{item.preview.warnings.join(" · ")}</Alert>
      )}
      {body ? (
        // Submitted content is DATA — shown verbatim, never run.
        <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-surface-muted/40 p-3 text-xs text-foreground">
          {body}
        </pre>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          This is a file upload — it has no AI proposal to preview. Approving it ingests, redacts and indexes the file.
        </p>
      )}
      {item.status !== "pending" && (
        <p className="text-xs text-muted-foreground">
          {statusLabel(item.status)}
          {item.reviewed_at ? " · " : ""}
          {item.reviewed_at ? <RelTime iso={item.reviewed_at} /> : null}
          {item.committed_object_id && item.status === "approved" ? (
            <>
              {" · "}
              {/* A bulk/file upload (ingest_one) commits a DOCUMENT; compile kinds commit a
                  knowledge OBJECT. Link each to the page that can resolve its id. */}
              <Link
                href={item.commit_via === "ingest_one" ? `/dashboard/documents/${item.committed_object_id}` : `/dashboard/knowledge/${item.committed_object_id}`}
                className="font-medium text-accent-strong underline-offset-2 hover:underline"
              >
                {item.commit_via === "ingest_one" ? "Open the document" : "Open the object"}
              </Link>
            </>
          ) : null}
        </p>
      )}
    </div>
  );
}
