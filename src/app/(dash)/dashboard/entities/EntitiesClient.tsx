"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Users, X } from "lucide-react";
import { ENTITY_KINDS } from "@/lib/intelligence-taxonomy";
import {
  Alert,
  Badge,
  Button,
  buttonClass,
  EmptyState,
  Field,
  SearchInput,
  SectionCard,
  Select,
  Table,
  TableCard,
  TableSkeletonRows,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from "@/components/ui";
import { api } from "@/components/ui/brain-ui";
import { fmtDate, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Entity { id: string; kind: string; name: string; slug: string; mention_count: number; aliases: string[]; created_at: string }
interface Mention { id: string; role: string | null; value: string | null; object_id: string | null; document_id: string | null; created_at: string; object: { id: string; ref: string; name: string } | null }

const LINK = "rounded-sm text-accent-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function EntitiesClient() {
  const [kind, setKind] = React.useState("");
  const [q, setQ] = React.useState("");
  const [list, setList] = React.useState<{ entities: Entity[]; counts: Record<string, number> } | null>(null);
  const [selected, setSelected] = React.useState<{ entity: Entity; mentions: Mention[] } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);

  const load = React.useCallback(async () => {
    try {
      const p = new URLSearchParams();
      if (kind) p.set("kind", kind);
      if (q.trim()) p.set("q", q.trim());
      const d = await api<{ entities: Entity[]; counts: Record<string, number>; migrationMissing?: boolean }>(`/api/admin/knowledge/entities?${p}`);
      setList(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [kind, q]);
  React.useEffect(() => { const t = window.setTimeout(load, q ? 250 : 0); return () => window.clearTimeout(t); }, [load, q]);

  const open = React.useCallback(async (id: string) => {
    try {
      const d = await api<{ entity: Entity; mentions: Mention[] }>(`/api/admin/knowledge/entities?id=${id}`);
      setSelected(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  // Deep link from an object page: ?id=<entityId>
  const params = useSearchParams();
  const deepLinkId = params.get("id");
  React.useEffect(() => {
    if (deepLinkId) void open(deepLinkId);
  }, [deepLinkId, open]);

  // Below lg the mentions panel sits under the list: bring it into view (and move
  // focus to it, so keyboard users don't have to tab past every row) when an entity is picked.
  React.useEffect(() => {
    const el = panelRef.current;
    if (!selected || !el) return;
    const r = el.getBoundingClientRect();
    if (r.top > window.innerHeight || r.bottom < 0) {
      el.scrollIntoView({ block: "start" });
      el.focus({ preventScroll: true });
    }
  }, [selected]);

  const filtered = Boolean(q.trim() || kind);
  const selectedId = selected?.entity.id;

  const head = (
    <THead>
      <tr>
        <Th>Kind</Th>
        <Th>Name</Th>
        <Th numeric>Mentions</Th>
        <Th>First seen</Th>
      </tr>
    </THead>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <SearchInput
            aria-label="Search entities"
            placeholder="Search entities…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            wrapperClassName="w-full sm:w-64"
          />
          <Field label="Kind" className="w-full sm:w-44">
            <Select
              density="compact"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              placeholder="All kinds"
              options={ENTITY_KINDS.map((k) => ({ value: k, label: `${humanize(k)}${list?.counts[k] ? ` (${list.counts[k]})` : ""}` }))}
            />
          </Field>
          {filtered && (
            <Button variant="ghost" size="toolbar" onClick={() => { setQ(""); setKind(""); }}>
              <X size={14} aria-hidden />
              Clear filters
            </Button>
          )}
        </div>
        {error && (
          <Alert tone="danger" onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}
        {!list ? (
          !error && (
            <TableCard>
              <Table caption="Entities (loading)">
                {head}
                <TBody>
                  <TableSkeletonRows rows={6} cols={4} />
                </TBody>
              </Table>
            </TableCard>
          )
        ) : list.entities.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={Users}
              title="No entities match"
              description="Try another search or kind."
              action={
                <Button variant="secondary" size="toolbar" onClick={() => { setQ(""); setKind(""); }}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Users}
              title="No entities yet"
              description="Entities are extracted when knowledge is compiled: people, departments, clients, offers, campaigns, platforms, frameworks, KPIs."
              action={
                <Link href="/dashboard/sources" className={buttonClass({ variant: "secondary", size: "toolbar" })}>
                  View sources
                </Link>
              }
            />
          )
        ) : (
          <TableCard>
            <Table caption="Entities" minWidth={480}>
              {head}
              <TBody>
                {list.entities.map((e) => {
                  const isSelected = selectedId === e.id;
                  return (
                    // Mouse users can click anywhere on the row; keyboard users use the name button.
                    <Tr
                      key={e.id}
                      interactive
                      onClick={() => open(e.id)}
                      className={cn("cursor-pointer", isSelected && "bg-accent-soft hover:bg-accent-soft")}
                    >
                      <Td>
                        <Badge tone="neutral">{humanize(e.kind)}</Badge>
                      </Td>
                      <Td>
                        <button
                          type="button"
                          aria-current={isSelected ? "true" : undefined}
                          aria-controls="entity-mentions"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            void open(e.id);
                          }}
                          className="rounded-sm text-left font-medium text-foreground hover:text-accent-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {e.name}
                        </button>
                        {e.aliases.length > 0 && <span className="ml-1 text-xs text-muted-foreground">({e.aliases.join(", ")})</span>}
                      </Td>
                      <Td numeric>{e.mention_count}</Td>
                      <Td className="whitespace-nowrap text-xs text-muted-foreground">{fmtDate(e.created_at)}</Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          </TableCard>
        )}
      </div>

      <div
        ref={panelRef}
        id="entity-mentions"
        tabIndex={-1}
        role="region"
        aria-label="Mentions"
        className="min-w-0 scroll-mt-4 focus:outline-none lg:sticky lg:top-4 lg:self-start"
      >
        <p className="sr-only" role="status">
          {selected
            ? `${selected.entity.name}: ${selected.mentions.length} ${selected.mentions.length === 1 ? "mention" : "mentions"}`
            : ""}
        </p>
        <SectionCard
          title={selected ? `${humanize(selected.entity.kind)}: ${selected.entity.name}` : "Mentions"}
          description={
            selected
              ? `${selected.mentions.length} ${selected.mentions.length === 1 ? "mention" : "mentions"}`
              : "Select an entity to see where it appears."
          }
        >
          {!selected ? (
            <p className="text-[13px] text-muted-foreground">No entity selected.</p>
          ) : selected.mentions.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No mentions recorded.</p>
          ) : (
            <ul className="space-y-1.5 text-[13px] lg:max-h-[60vh] lg:overflow-y-auto">
              {selected.mentions.map((m) => (
                <li key={m.id} className="rounded-xl border border-border px-3 py-2 text-foreground">
                  {m.object ? (
                    <Link href={`/dashboard/knowledge/${m.object.id}`} className={LINK}>
                      <span className="font-mono text-xs">{m.object.ref}</span> {m.object.name}
                    </Link>
                  ) : m.document_id ? (
                    <Link href={`/dashboard/documents/${m.document_id}`} className={LINK}>
                      Document
                    </Link>
                  ) : (
                    "—"
                  )}
                  {(m.role || m.value) && (
                    <div className="mt-0.5 text-xs text-muted-foreground">{[m.role, m.value].filter(Boolean).join(": ")}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
