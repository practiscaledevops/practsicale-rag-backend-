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

import * as React from "react";
import { Plus, Loader2, Check, Sparkles, MessageSquareText } from "lucide-react";
import { GROUNDED_SYSTEM } from "@/lib/prompts";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card";
import { Table, THead, TBody, Tr, Th, Td } from "@/components/ui/Table";

interface Prompt {
  id: string;
  use_case: string;
  version: number;
  content: string;
  is_active: boolean;
  created_at: string;
}

interface Notice {
  tone: "success" | "danger";
  message: string;
}

/** Shared classes so the prompt textarea matches the design-system Input. */
const TEXTAREA_CLASS =
  "flex w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs leading-relaxed " +
  "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background " +
  "disabled:cursor-not-allowed disabled:opacity-50";

/** Read-only preview of a prompt's grounding rules. */
function Preview({ content }: { content: string }) {
  return (
    <div className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-muted/40 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
      {content.trim() ? content : "Nothing to preview yet."}
    </div>
  );
}

export default function PromptsPage() {
  const [prompts, setPrompts] = React.useState<Prompt[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  // Editor (create-a-version) dialog state.
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [isNewUseCase, setIsNewUseCase] = React.useState(false);
  const [editorUseCase, setEditorUseCase] = React.useState("");
  const [editorContent, setEditorContent] = React.useState("");
  const [activateOnSave, setActivateOnSave] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

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

  async function save() {
    const useCase = editorUseCase.trim();
    if (!useCase || !editorContent.trim()) return;
    setSaving(true);
    setNotice(null);
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
      setNotice({
        tone: "danger",
        message: e instanceof Error ? e.message : "Failed to save version",
      });
    } finally {
      setSaving(false);
    }
  }

  const useCases = [...groups.keys()];
  const isChatEditor = editorUseCase.trim() === "chat";

  return (
    <div>
      <PageHeader
        title="Prompts"
        description="Versioned system prompts that ground the assistant. Stored in the database and editable without a redeploy."
        actions={
          <Button onClick={() => openEditor({ useCase: "", content: "", isNew: true, activate: true })}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New use case
          </Button>
        }
      />

      {notice && (
        <Alert tone={notice.tone} className="mb-4">
          {notice.message}
        </Alert>
      )}
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading prompts…
        </div>
      ) : (
        <div className="space-y-6">
          {/* The built-in default for the 'chat' use case. Always shown so admins
              can see the grounding rules that ship in the app and fork from them.
              It applies whenever no saved 'chat' version is active. */}
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2">
                  <MessageSquareText className="h-4 w-4 text-accent" aria-hidden="true" />
                  Built-in default · chat
                </CardTitle>
                <CardDescription>
                  The grounding rules compiled into the app. In effect for the{" "}
                  <code className="font-mono">chat</code> use case whenever no saved
                  version is active. Save a version to override it.
                </CardDescription>
              </div>
              <Badge tone="neutral">built-in</Badge>
            </CardHeader>
            <CardContent>
              <Preview content={GROUNDED_SYSTEM} />
            </CardContent>
            <CardFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  openEditor({ useCase: "chat", content: GROUNDED_SYSTEM, activate: false })
                }
              >
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                Create version from default
              </Button>
            </CardFooter>
          </Card>

          {/* Saved prompts, grouped by use_case. */}
          {useCases.length === 0 ? (
            <EmptyState
              icon={MessageSquareText}
              title="No saved prompts yet"
              description="Create a version to override a built-in prompt, or start a new use case."
              action={
                <Button
                  size="sm"
                  onClick={() => openEditor({ useCase: "", content: "", isNew: true, activate: true })}
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  New use case
                </Button>
              }
            />
          ) : (
            useCases.map((useCase) => {
              const versions = groups.get(useCase)!;
              const active = versions.find((v) => v.is_active);
              return (
                <Card key={useCase}>
                  <CardHeader className="flex flex-row items-start justify-between gap-4">
                    <div className="min-w-0">
                      <CardTitle className="font-mono">{useCase}</CardTitle>
                      <CardDescription>
                        {versions.length} version{versions.length === 1 ? "" : "s"}
                      </CardDescription>
                    </div>
                    {active ? (
                      <Badge tone="success">v{active.version} active</Badge>
                    ) : (
                      <Badge tone="warning">no active version</Badge>
                    )}
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <THead>
                        <Tr>
                          <Th>Version</Th>
                          <Th>Status</Th>
                          <Th>Created</Th>
                          <Th className="text-right">Actions</Th>
                        </Tr>
                      </THead>
                      <TBody>
                        {versions.map((v) => (
                          <Tr key={v.id}>
                            <Td className="font-medium tabular-nums">v{v.version}</Td>
                            <Td>
                              {v.is_active ? (
                                <Badge tone="success">Active</Badge>
                              ) : (
                                <Badge tone="neutral">Inactive</Badge>
                              )}
                            </Td>
                            <Td className="text-muted-foreground">
                              {new Date(v.created_at).toLocaleString()}
                            </Td>
                            <Td>
                              <div className="flex items-center justify-end gap-2">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    openEditor({ useCase, content: v.content, activate: false })
                                  }
                                >
                                  View / edit
                                </Button>
                                {!v.is_active && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => activate(v.id)}
                                    disabled={busyId === v.id}
                                  >
                                    {busyId === v.id ? (
                                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                                    ) : (
                                      <Check className="h-4 w-4" aria-hidden="true" />
                                    )}
                                    Activate
                                  </Button>
                                )}
                              </div>
                            </Td>
                          </Tr>
                        ))}
                      </TBody>
                    </Table>
                  </CardContent>
                  <CardFooter>
                    <Button variant="outline" size="sm" onClick={() => newVersionFor(useCase)}>
                      <Plus className="h-4 w-4" aria-hidden="true" />
                      New version
                    </Button>
                  </CardFooter>
                </Card>
              );
            })
          )}
        </div>
      )}

      {/* Editor dialog — every save creates a new version. */}
      <Dialog
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={isNewUseCase ? "New prompt" : `Edit prompt · ${editorUseCase}`}
        description="Saving creates a new version. Activate it to make it live."
        className="max-w-3xl"
        footer={
          <>
            <Button variant="outline" onClick={() => setEditorOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={saving || !editorContent.trim() || (isNewUseCase && !editorUseCase.trim())}
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {saving ? "Saving…" : "Save as new version"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {isNewUseCase && (
            <div className="space-y-1.5">
              <Label htmlFor="use-case">Use case</Label>
              <Input
                id="use-case"
                value={editorUseCase}
                onChange={(e) => setEditorUseCase(e.target.value)}
                placeholder="e.g. chat, summarize, coaching"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                A short key that identifies where this prompt is used.
              </p>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="content">Content</Label>
                {isChatEditor && (
                  <button
                    type="button"
                    onClick={() => setEditorContent(GROUNDED_SYSTEM)}
                    className="text-xs font-medium text-accent hover:underline"
                  >
                    Load built-in default
                  </button>
                )}
              </div>
              <textarea
                id="content"
                rows={14}
                value={editorContent}
                onChange={(e) => setEditorContent(e.target.value)}
                placeholder="Write the system prompt / grounding rules…"
                className={TEXTAREA_CLASS}
                spellCheck={false}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Grounding rules preview</Label>
              <Preview content={editorContent} />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={activateOnSave}
              onChange={(e) => setActivateOnSave(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span>Activate this version on save</span>
          </label>
        </div>
      </Dialog>
    </div>
  );
}
