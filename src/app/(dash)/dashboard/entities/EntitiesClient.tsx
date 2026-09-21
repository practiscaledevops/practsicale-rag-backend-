"use client";

import * as React from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { ENTITY_KINDS, humanize } from "@/lib/intelligence-taxonomy";
import { C, Chip, KInput, KSelect, KTable, Th, Td, Panel, Empty, Spinner, ErrorNote, api, fmtDate } from "@/components/ui/brain-ui";

interface Entity { id: string; kind: string; name: string; slug: string; mention_count: number; aliases: string[]; created_at: string }
interface Mention { id: string; role: string | null; value: string | null; object_id: string | null; document_id: string | null; created_at: string; object: { id: string; ref: string; name: string } | null }

export function EntitiesClient() {
  const [kind, setKind] = React.useState("");
  const [q, setQ] = React.useState("");
  const [list, setList] = React.useState<{ entities: Entity[]; counts: Record<string, number> } | null>(null);
  const [selected, setSelected] = React.useState<{ entity: Entity; mentions: Mention[] } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

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
  React.useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (id) void open(id);
  }, [open]);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-3 lg:col-span-2">
        <div className="grid gap-2 md:grid-cols-3">
          <div className="relative md:col-span-2">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5" style={{ color: C.muted }} />
            <KInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search entities…" className="pl-8" />
          </div>
          <KSelect value={kind} onChange={(e) => setKind(e.target.value)} placeholder="All kinds" options={ENTITY_KINDS.map((k) => ({ value: k, label: `${humanize(k)}${list?.counts[k] ? ` (${list.counts[k]})` : ""}` }))} />
        </div>
        <ErrorNote message={error} />
        {!list ? <Spinner /> : list.entities.length === 0 ? (
          <Empty title="No entities yet" hint="Entities are extracted when knowledge is compiled: people, departments, clients, offers, campaigns, platforms, frameworks, KPIs." />
        ) : (
          <KTable head={<><Th>Kind</Th><Th>Name</Th><Th>Mentions</Th><Th>First seen</Th></>}>
            {list.entities.map((e) => (
              <tr key={e.id} className="cursor-pointer hover:bg-white/[0.03]" onClick={() => open(e.id)} style={selected?.entity.id === e.id ? { background: "rgba(0,191,174,0.06)" } : undefined}>
                <Td><Chip tone="muted">{humanize(e.kind)}</Chip></Td>
                <Td><span className="font-medium" style={{ color: C.text }}>{e.name}</span>{e.aliases.length > 0 && <span className="ml-1 text-xs" style={{ color: C.muted }}>({e.aliases.join(", ")})</span>}</Td>
                <Td><span style={{ color: C.green }}>{e.mention_count}</span></Td>
                <Td className="text-xs"><span style={{ color: C.muted }}>{fmtDate(e.created_at)}</span></Td>
              </tr>
            ))}
          </KTable>
        )}
      </div>
      <Panel title={selected ? `${humanize(selected.entity.kind)}: ${selected.entity.name}` : "Mentions"} subtitle={selected ? `${selected.mentions.length} mention(s)` : "Select an entity to see where it appears."}>
        {!selected ? <p className="text-xs" style={{ color: C.muted }}>—</p> : selected.mentions.length === 0 ? <p className="text-xs" style={{ color: C.muted }}>No mentions recorded.</p> : (
          <ul className="space-y-1.5 text-xs">
            {selected.mentions.map((m) => (
              <li key={m.id} className="rounded-lg px-2 py-1.5" style={{ border: `1px solid ${C.border}`, color: C.text }}>
                {m.object ? <Link href={`/dashboard/knowledge/${m.object.id}`}><span className="font-mono" style={{ color: C.green }}>{m.object.ref}</span> {m.object.name}</Link> : m.document_id ? <Link href={`/dashboard/documents/${m.document_id}`} style={{ color: C.green }}>document</Link> : "—"}
                {(m.role || m.value) && <div style={{ color: C.muted }}>{[m.role, m.value].filter(Boolean).join(": ")}</div>}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
