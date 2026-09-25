"use client";

// Prompt Studio — list, version, and activate the system prompts that ground the
// assistant. Prompts live in the database (not code), so editing here changes
// behaviour without a redeploy. "Editing" always saves a NEW version; exactly one
// version per use_case is active at a time.
//
// This page is a Client Component because it is an interactive editor. All data
// access goes through /api/admin/prompts, which resolves org_id server-side and
// enforces the admin's `prompts` permission — the browser never sees another
// tenant's prompts and never supplies an org id.
//
// Presentation: one card per built-in use case (its default prompt plus the
// saved versions for it, grouped from the one prompts list the page loads);
// saved prompts for any other use case go in a table below.

import * as React from "react";
import { Check, ChevronRight, FileText, MessageSquareText, Pencil, Plus, Sparkles } from "lucide-react";
import { PROMPT_USE_CASES, defaultPromptFor } from "@/lib/prompts";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Label } from "@/components/ui/Label";
import { Field } from "@/components/ui/Field";
import { Checkbox } from "@/components/ui/Checkbox";
import { Alert, Notice } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { SectionCard } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { Skeleton } from "@/components/ui/Loading";
import { Table, THead, TBody, Tr, Th, Td, TableCard } from "@/components/ui/Table";
import { fmtDateTime } from "@/lib/format";

interface Prompt {
  id: string;
  use_case: string;
  version: number;
  content: string;
  is_active: boolean;
  created_at: string;
}

interface Feedback {
  tone: "success" | "danger";
  message: string;
}

const BUILT_IN_KEYS = new Set(PROMPT_USE_CASES.map((u) => u.key));

export default function PromptsPage() {
  const [prompts, setPrompts] = React.useState<Prompt[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<Feedback | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  // Editor (create-a-version) dialog state.
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [isNewUseCase, setIsNewUseCase] = React.useState(false);
  const [editorUseCase, setEditorUseCase] = React.useState("");
  const [editorContent, setEditorContent] = React.useState("");
  const [activateOnSave, setActivateOnSave] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  // A failed save shows inside the editor dialog (the page behind it is under the scrim).
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const { confirm, dialog } = useConfirm();

  const loadPrompts = React.useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/prompts", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load prompts");
      setPrompts(json.prompts as Prompt[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load prompts");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadPrompts();
  }, [loadPrompts]);

  // Group versions by use_case, preserving the API's (use_case asc) order.
  const groups = React.useMemo(() => {
    const map = new Map<string, Prompt[]>();
    for (const p of prompts) {
      const list = map.get(p.use_case) ?? [];
      list.push(p);
      map.set(p.use_case, list);
    }
    // Within a use_case, keep newest version first.
    for (const list of map.values()) list.sort((a, b) => b.version - a.version);
    return map;
  }, [prompts]);

  function openEditor(opts: {
    useCase: string;
    content: string;
    isNew?: boolean;
    activate?: boolean;
  }) {
    setNotice(null);
    setSaveError(null);
    setEditorUseCase(opts.useCase);
    setEditorContent(opts.content);
    setIsNewUseCase(opts.isNew ?? false);
    setActivateOnSave(opts.activate ?? false);
    setEditorOpen(true);
  }

  /** Prefill from the active version (or newest) of an existing use_case. */
  function newVersionFor(useCase: string) {
    const list = groups.get(useCase) ?? [];
    const seed = list.find((p) => p.is_active) ?? list[0];
    openEditor({ useCase, content: seed?.content ?? "", activate: false });
  }

  async function activate(id: string) {
    setNotice(null);
    setBusyId(id);
    try {
      const res = await fetch("/api/admin/prompts", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to activate version");
      await loadPrompts();
      setNotice({ tone: "success", message: "Version activated." });
    } catch (e) {
      setNotice({
        tone: "danger",
        message: e instanceof Error ? e.message : "Failed to activate version",
      });
    } finally {
      setBusyId(null);
    }
  }

  /** Activation is org-wide, so it asks first; then the same handler runs. */
  async function requestActivate(id: string) {
    const ok = await confirm({
      title: "Make this prompt live?",
      description: "This changes answers for everyone in the organisation right away.",
      confirmLabel: "Activate",
    });
    if (ok) await activate(id);
  }

  async function save() {
    const useCase = editorUseCase.trim();
    if (!useCase || !editorContent.trim()) return;
    setSaving(true);
    setNotice(null);
    setSaveError(null);
    try {
      const res = await fetch("/api/admin/prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          use_case: useCase,
          content: editorContent,
          activate: activateOnSave,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to save version");
      const saved = json.prompt as Prompt;
      setEditorOpen(false);
      await loadPrompts();
      setNotice({
        tone: "success",
        message: `Saved ${saved.use_case} v${saved.version}${
          saved.is_active ? " and activated it" : ""
        }.`,
      });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save version");
    } finally {
      setSaving(false);
    }
  }

  const useCases = [...groups.keys()];
  const otherUseCases = useCases.filter((u) => !BUILT_IN_KEYS.has(u));
  const knownUseCase = PROMPT_USE_CASES.some((u) => u.key === editorUseCase.trim());

  return (
    <div>
      <PageHeader
        title="Prompts"
        description="The instructions the Brain follows for each use case. Changes apply to everyone."
        actions={
          <Button size="toolbar" onClick={() => openEditor({ useCase: "", content: "", isNew: true, activate: true })}>
            <Plus size={14} aria-hidden />
            New use case
          </Button>
        }
      />

      {notice?.tone === "success" && (
        <Notice className="mb-4" message={notice.message} onDone={() => setNotice(null)} />
      )}
      {notice?.tone === "danger" && (
        <Alert tone="danger" className="mb-4" onDismiss={() => setNotice(null)}>
          {notice.message}
        </Alert>
      )}
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}

      {loading ? (
        <div role="status" className="space-y-4">
          <span className="sr-only">Loading prompts…</span>
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
        </div>
      ) : (
        <div className="space-y-4">
          {/* Built-in defaults for EVERY pipeline stage. Each is editable: fork it
              into a saved, activatable version. A stage uses its saved active
              version when one exists, otherwise this compiled default. */}
          {PROMPT_USE_CASES.map((uc) => (
            <UseCaseCard
              key={uc.key}
              useCase={uc.key}
              label={uc.label}
              description={uc.description}
              defaultText={uc.default}
              versions={groups.get(uc.key) ?? []}
              busyId={busyId}
              onEditDefault={() => openEditor({ useCase: uc.key, content: uc.default, activate: false })}
              onNewVersion={() => newVersionFor(uc.key)}
              onOpenVersion={(v) => openEditor({ useCase: uc.key, content: v.content, activate: false })}
              onActivate={(id) => void requestActivate(id)}
            />
          ))}

          {/* Saved prompts for use cases without a built-in card. */}
          {otherUseCases.length > 0 && (
            <TableCard
              id="other-prompts"
              title="Other saved prompts"
              meta="Use cases without a built-in default"
            >
              <Table minWidth={640} caption="Other saved prompts">
                <THead>
                  <tr>
                    <Th>Use case</Th>
                    <Th>Version</Th>
                    <Th>Status</Th>
                    <Th>Created</Th>
                    <Th className="text-right">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </THead>
                <TBody>
                  {otherUseCases.map((useCase) => {
                    const versions = groups.get(useCase)!;
                    const active = versions.find((v) => v.is_active);
                    return (
                      <React.Fragment key={useCase}>
                        {versions.map((v, i) => (
                          <Tr key={v.id}>
                            {i === 0 && (
                              <Td rowSpan={versions.length} className="align-top">
                                <div id={`prompt-${useCase}`} className="font-mono text-[13px] font-medium">
                                  {useCase}
                                </div>
                                {!active && (
                                  <Badge tone="warning" className="mt-1">
                                    No active version
                                  </Badge>
                                )}
                                <div className="mt-1">
                                  <Button variant="ghost" size="sm" className="-ml-3" onClick={() => newVersionFor(useCase)}>
                                    <Plus size={14} aria-hidden />
                                    New version
                                  </Button>
                                </div>
                              </Td>
                            )}
                            <Td className="font-mono tabular-nums">v{v.version}</Td>
                            <Td>
                              {v.is_active ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}
                            </Td>
                            <Td className="whitespace-nowrap text-muted-foreground">{fmtDateTime(v.created_at)}</Td>
                            <Td>
                              <VersionActions
                                version={v}
                                busy={busyId === v.id}
                                onOpen={() => openEditor({ useCase, content: v.content, activate: false })}
                                onActivate={() => void requestActivate(v.id)}
                              />
                            </Td>
                          </Tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </TBody>
              </Table>
            </TableCard>
          )}
        </div>
      )}

      {/* Editor dialog — every save creates a new version. */}
      <Dialog
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={isNewUseCase ? "New prompt" : `Edit prompt · ${editorUseCase}`}
        description="Saving creates a new version. Activate it to make it live."
        size="xl"
        closeOnBackdrop={false}
        dismissible={!saving}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditorOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={() => void save()}
              disabled={!editorContent.trim() || (isNewUseCase && !editorUseCase.trim())}
              loading={saving}
            >
              {saving ? "Saving…" : "Save as new version"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {saveError && <Alert tone="danger">{saveError}</Alert>}
          {isNewUseCase && (
            <Field label="Use case" hint="A short key that identifies where this prompt is used.">
              <Input
                id="use-case"
                value={editorUseCase}
                onChange={(e) => setEditorUseCase(e.target.value)}
                placeholder="e.g. chat, summarize, coaching"
                autoComplete="off"
              />
            </Field>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="prompt-content">Prompt</Label>
              {knownUseCase && (
                <button
                  type="button"
                  onClick={() => setEditorContent(defaultPromptFor(editorUseCase.trim()))}
                  className="rounded-md text-xs font-medium text-accent-strong underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Load built-in default
                </button>
              )}
            </div>
            <Textarea
              id="prompt-content"
              mono
              rows={14}
              value={editorContent}
              onChange={(e) => setEditorContent(e.target.value)}
              placeholder="Write the system prompt / grounding rules…"
              spellCheck={false}
            />
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border px-3 py-2.5 transition-colors hover:bg-surface-muted">
            <Checkbox
              checked={activateOnSave}
              onChange={(e) => setActivateOnSave(e.target.checked)}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-foreground">Activate this version on save</span>
              <span className="block text-xs text-muted-foreground">
                Makes it live for everyone in the organisation as soon as it saves.
              </span>
            </span>
          </label>
        </div>
      </Dialog>

      {dialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presentation pieces
// ---------------------------------------------------------------------------

/** View/edit a saved version, and activate it when it isn't live. */
function VersionActions({
  version,
  busy,
  onOpen,
  onActivate,
}: {
  version: Prompt;
  busy: boolean;
  onOpen: () => void;
  onActivate: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      <Button variant="ghost" size="sm" onClick={onOpen}>
        View / edit<span className="sr-only"> v{version.version}</span>
      </Button>
      {!version.is_active && (
        <Button variant="secondary" size="sm" onClick={onActivate} loading={busy}>
          {!busy && <Check size={14} aria-hidden />}
          Activate<span className="sr-only"> v{version.version}</span>
        </Button>
      )}
    </div>
  );
}

/** One built-in use case: what's live, its default prompt, and its saved versions. */
function UseCaseCard({
  useCase,
  label,
  description,
  defaultText,
  versions,
  busyId,
  onEditDefault,
  onNewVersion,
  onOpenVersion,
  onActivate,
}: {
  useCase: string;
  label: string;
  description: string;
  defaultText: string;
  versions: Prompt[];
  busyId: string | null;
  onEditDefault: () => void;
  onNewVersion: () => void;
  onOpenVersion: (v: Prompt) => void;
  onActivate: (id: string) => void;
}) {
  const active = versions.find((v) => v.is_active);
  const hasVersions = versions.length > 0;

  return (
    <SectionCard
      id={`prompt-${useCase}`}
      icon={MessageSquareText}
      title={
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          {label}
          {active ? <Badge tone="accent">Custom · active</Badge> : <Badge tone="neutral">Default</Badge>}
        </span>
      }
      description={description}
      actions={
        hasVersions ? (
          <Button variant="secondary" size="toolbar" onClick={onNewVersion}>
            <Plus size={14} aria-hidden />
            New version
          </Button>
        ) : (
          <Button variant="secondary" size="toolbar" onClick={onEditDefault}>
            <Pencil size={14} aria-hidden />
            Edit
          </Button>
        )
      }
      bodyClassName="space-y-3"
    >
      <p className="text-[13px] text-muted-foreground">
        <code className="mr-1.5 rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
          {useCase}
        </code>
        {active ? (
          <>
            Live: <span className="font-medium text-foreground">saved version v{active.version}</span>, created{" "}
            {fmtDateTime(active.created_at)}.
          </>
        ) : hasVersions ? (
          <>
            Live: <span className="font-medium text-foreground">the default prompt</span>. None of the saved
            versions is active.
          </>
        ) : (
          <>
            Live: <span className="font-medium text-foreground">the default prompt</span>. Edit it to save a
            custom version.
          </>
        )}
      </p>

      <details className="group rounded-xl border border-border">
        <summary className="flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-xl px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight
            size={14}
            aria-hidden
            className="shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
          />
          Default prompt
        </summary>
        <div className="space-y-2 border-t border-border p-3">
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-surface-muted p-3 font-mono text-xs text-foreground">
            {defaultText}
          </pre>
          <Button variant="ghost" size="sm" onClick={onEditDefault}>
            <Sparkles size={14} aria-hidden />
            Create version from default
          </Button>
        </div>
      </details>

      {hasVersions && (
        <div>
          <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <FileText size={14} aria-hidden />
            Saved versions
          </h3>
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-surface px-3 py-2">
                <span className="font-mono text-[13px] font-medium tabular-nums text-foreground">v{v.version}</span>
                {v.is_active && <Badge tone="success">Active</Badge>}
                <span className="text-xs text-muted-foreground">{fmtDateTime(v.created_at)}</span>
                <div className="ml-auto">
                  <VersionActions
                    version={v}
                    busy={busyId === v.id}
                    onOpen={() => onOpenVersion(v)}
                    onActivate={() => onActivate(v.id)}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}
