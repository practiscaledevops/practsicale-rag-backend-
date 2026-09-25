"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Link2, Network, X } from "lucide-react";
import { RELATIONSHIP_TYPES, relationshipLabel } from "@/lib/intelligence-taxonomy";
import {
  Alert,
  Badge,
  Button,
  ClassBadge,
  EmptyState,
  Field,
  FilterTabs,
  IconButton,
  InlineError,
  Input,
  Notice,
  SectionCard,
  Select,
  Spinner,
  Table,
  TableCard,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from "@/components/ui";
import { api } from "@/components/ui/brain-ui";
import { humanize } from "@/lib/format";

interface Edge {
  id: string;
  source_object_id: string;
  relationship_type: string;
  target_object_id: string;
  status: string;
  confidence: number | null;
  origin: string;
  note: string | null;
  created_at: string;
}
interface Stub { id: string; ref: string; name: string; intelligence_class: string }
interface Resp { edges: Edge[]; objects: Record<string, Stub>; counts: Record<string, number>; error?: string; migrationMissing?: boolean }

type Status = "suggested" | "confirmed" | "rejected";

const ORIGIN_LABEL: Record<string, string> = {
  ai: "AI suggested",
  system: "Automatic",
  markdown: "From markdown",
  user: "Manual",
};

const TABLE_LINK =
  "rounded-sm font-medium text-foreground hover:text-accent-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function ObjectCell({ stub, withClass }: { stub: Stub | undefined; withClass?: boolean }) {
  if (!stub) return <span className="text-muted-foreground">Unknown object</span>;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-mono text-xs text-muted-foreground">{stub.ref}</span>
      <Link href={`/dashboard/knowledge/${stub.id}`} className={TABLE_LINK}>
        {stub.name}
      </Link>
      {withClass && <ClassBadge klass={stub.intelligence_class} />}
    </div>
  );
}

export function RelationshipsClient() {
  const [status, setStatus] = React.useState<Status>("suggested");
  const [data, setData] = React.useState<Resp | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [form, setForm] = React.useState({ sourceRef: "", type: "related_to", targetRef: "", note: "" });
  // Inline feedback for the type select, which saves (and confirms) on change.
  const [typeSave, setTypeSave] = React.useState<{ id: string; state: "saving" | "error" } | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const d = await api<Resp>(`/api/admin/knowledge/relationships?status=${status}`);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [status]);
  React.useEffect(() => { void load(); }, [load]);

  /** Returns whether the request succeeded (for the inline type-select feedback). */
  async function act(body: Record<string, unknown>, method: "PATCH" | "POST"): Promise<boolean> {
    setBusy(true);
    try {
      await api("/api/admin/knowledge/relationships", { method, body: JSON.stringify(body) });
      await load();
      if (method === "POST") setForm({ ...form, sourceRef: "", targetRef: "", note: "" });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function changeType(e: Edge, type: string) {
    setTypeSave({ id: e.id, state: "saving" });
    const ok = await act({ id: e.id, action: "confirm", type }, "PATCH");
    setTypeSave(ok ? null : { id: e.id, state: "error" });
    if (ok) setNotice(`Saved: confirmed as “${relationshipLabel(type)}”.`);
  }

  const counts = data?.counts ?? {};
  const O = (id: string): Stub | undefined => data?.objects[id];
  const refOf = (id: string) => O(id)?.ref ?? "unknown";

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="min-w-0 space-y-3 lg:col-span-2">
        <FilterTabs
          label="Relationship status"
          value={status}
          onChange={setStatus}
          tabs={[
            { id: "suggested", label: "Suggested", count: counts.suggested },
            { id: "confirmed", label: "Confirmed", count: counts.confirmed },
            { id: "rejected", label: "Rejected", count: counts.rejected },
          ]}
        />
        {data?.migrationMissing && (
          <Alert tone="info" title="Not enabled yet">
            <p>Relationships aren&apos;t set up in this workspace&apos;s database yet.</p>
            <details className="mt-1">
              <summary className="cursor-pointer text-xs font-medium text-foreground">Technical details</summary>
              <p className="mt-1 text-xs">
                Apply Brain migration <code className="font-mono">0017_operating_intelligence.sql</code> to enable
                relationships.
              </p>
            </details>
          </Alert>
        )}
        {notice && <Notice message={notice} onDone={() => setNotice(null)} />}
        {error && (
          <Alert tone="danger" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}
        {!data ? (
          !error && <Spinner label="Loading relationships…" />
        ) : data.edges.length === 0 ? (
          <EmptyState
            icon={Network}
            title={status === "suggested" ? "No suggestions waiting" : `No ${status} relationships`}
            description="The compiler suggests links when a new object is semantically close to an existing one; enrichment, conflict and learning links are created automatically."
          />
        ) : (
          <TableCard
            title={`${humanize(status)} relationships`}
            meta={status === "suggested" ? "Picking a type confirms the link with that type." : undefined}
          >
            <Table caption={`${humanize(status)} relationships`}>
              <THead>
                <tr>
                  <Th>Source</Th>
                  <Th>Relationship</Th>
                  <Th>Target</Th>
                  <Th>Origin</Th>
                  <Th className="text-right">
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </THead>
              <TBody>
                {data.edges.map((e) => {
                  const pair = `${refOf(e.source_object_id)} → ${refOf(e.target_object_id)}`;
                  const saving = typeSave?.id === e.id && typeSave.state === "saving";
                  const failed = typeSave?.id === e.id && typeSave.state === "error";
                  return (
                    <Tr key={e.id} interactive>
                      <Td>
                        <ObjectCell stub={O(e.source_object_id)} withClass />
                      </Td>
                      <Td>
                        {status === "suggested" ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <Select
                              density="compact"
                              className="w-44"
                              aria-label={`Relationship type for ${pair}`}
                              value={e.relationship_type}
                              onChange={(ev) => changeType(e, ev.target.value)}
                              disabled={busy}
                              options={RELATIONSHIP_TYPES.map((r) => ({ value: r.id, label: r.label }))}
                            />
                            {saving && (
                              <span role="status" className="text-xs text-muted-foreground">
                                Saving…
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-foreground">{relationshipLabel(e.relationship_type)}</span>
                        )}
                        {failed && <InlineError message="Couldn't save the new type." className="mt-1" />}
                        {e.note && <div className="mt-0.5 text-xs text-muted-foreground">{e.note}</div>}
                      </Td>
                      <Td>
                        <ObjectCell stub={O(e.target_object_id)} />
                      </Td>
                      <Td>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge tone="neutral">{ORIGIN_LABEL[e.origin] ?? humanize(e.origin)}</Badge>
                          {typeof e.confidence === "number" && (
                            <span className="text-xs tabular-nums text-muted-foreground">{Math.round(e.confidence * 100)}%</span>
                          )}
                        </div>
                      </Td>
                      <Td>
                        <div className="flex items-center justify-end gap-1">
                          {status !== "confirmed" && (
                            <Button size="sm" disabled={busy} aria-label={`Confirm ${pair}`} onClick={() => act({ id: e.id, action: "confirm" }, "PATCH")}>
                              <Check size={14} aria-hidden />
                              Confirm
                            </Button>
                          )}
                          {status !== "rejected" && (
                            <IconButton
                              size="sm"
                              aria-label={status === "suggested" ? `Reject ${pair}` : `Remove ${pair}`}
                              title={status === "suggested" ? "Reject" : "Remove"}
                              disabled={busy}
                              onClick={() => act({ id: e.id, action: "reject" }, "PATCH")}
                            >
                              <X size={14} aria-hidden />
                            </IconButton>
                          )}
                        </div>
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          </TableCard>
        )}
      </div>
      <SectionCard
        className="self-start"
        title="Connect two objects"
        description="Link two objects by ref. The link is confirmed straight away."
      >
        <div className="space-y-3">
          <Field label="Source ref" hint="The ref of the object the link starts from, as shown on Knowledge objects (e.g. MG-001).">
            <Input value={form.sourceRef} onChange={(e) => setForm({ ...form, sourceRef: e.target.value.toUpperCase() })} placeholder="MG-001" className="font-mono" />
          </Field>
          <Field label="Relationship">
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} options={RELATIONSHIP_TYPES.map((r) => ({ value: r.id, label: r.label }))} />
          </Field>
          <Field label="Target ref" hint="The ref of the object it points to (e.g. MG-002).">
            <Input value={form.targetRef} onChange={(e) => setForm({ ...form, targetRef: e.target.value.toUpperCase() })} placeholder="MG-002" className="font-mono" />
          </Field>
          <Field label="Note">
            <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
          <Button disabled={!form.sourceRef || !form.targetRef || busy} onClick={() => act(form, "POST")}>
            <Link2 size={16} aria-hidden />
            Add relationship
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}
