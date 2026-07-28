"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Card, CardContent } from "@/components/ui/Card";
import { Table, THead, TBody, Tr, Th, Td } from "@/components/ui/Table";

/** One document row for the list (chunk_count is aggregated server-side). */
export interface DocumentRow {
  id: string;
  title: string | null;
  source_type: string;
  uri: string | null;
  created_at: string;
  chunk_count: number;
}

const SOURCE_LABELS: Record<string, string> = {
  document: "Document",
  call_score: "Call score",
  coaching: "Coaching",
  transcript: "Transcript",
};
const sourceLabel = (v: string) => SOURCE_LABELS[v] ?? v;

export function DocumentsClient({ documents }: { documents: DocumentRow[] }) {
  const router = useRouter();
  const [target, setTarget] = React.useState<DocumentRow | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function confirmDelete() {
    if (!target) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/documents?id=${encodeURIComponent(target.id)}`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `Delete failed (${res.status})`);
        return;
      }
      setTarget(null);
      router.refresh(); // re-run the server component to drop the row
    } catch {
      setError("Network error — please try again.");
    } finally {
      setDeleting(false);
    }
  }

  if (documents.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="No documents yet"
        description="Upload a file or sync a data source to populate the knowledge base."
      />
    );
  }

  return (
    <>
      {error && (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <THead>
              <Tr>
                <Th>Title</Th>
                <Th>Type</Th>
                <Th className="text-right">Chunks</Th>
                <Th>Created</Th>
                <Th className="text-right">Actions</Th>
              </Tr>
            </THead>
            <TBody>
              {documents.map((d) => (
                <Tr key={d.id}>
                  <Td className="font-medium">
                    {d.title || <span className="text-muted-foreground">Untitled</span>}
                  </Td>
                  <Td>
                    <Badge tone="accent">{sourceLabel(d.source_type)}</Badge>
                  </Td>
                  <Td className="text-right tabular-nums">{d.chunk_count.toLocaleString()}</Td>
                  <Td className="text-muted-foreground">
                    {new Date(d.created_at).toLocaleString()}
                  </Td>
                  <Td className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setError(null);
                        setTarget(d);
                      }}
                      aria-label={`Delete ${d.title || "document"}`}
                    >
                      <Trash2 className="h-4 w-4 text-danger" aria-hidden="true" />
                      Delete
                    </Button>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog
        open={target !== null}
        onClose={() => (deleting ? undefined : setTarget(null))}
        title="Delete document?"
        description={
          target
            ? `“${target.title || "Untitled"}” and its ${target.chunk_count} chunk${
                target.chunk_count === 1 ? "" : "s"
              } will be permanently removed. This cannot be undone.`
            : undefined
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDelete} disabled={deleting}>
              {deleting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              )}
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </>
        }
      />
    </>
  );
}
