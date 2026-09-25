"use client";

// Playground — an internal, admin-only test chat.
//
// Streams from POST /api/admin/playground, which authenticates with the admin
// session (NOT a public key) and searches the FULL org. Lets an admin pick a
// model tier and optionally filter by source_type, and shows the grounded
// answer's citations.
//
// Transport: the route returns NDJSON — one JSON object per line. The first line
// is the citations payload, then one line per streamed text delta.
//
// Layout: a full-bleed route (the shell gives it `flex h-full min-h-0 flex-col`
// with no padding). Header and composer are fixed; only the transcript scrolls.

import * as React from "react";
import { BrainCircuit, ChevronRight, Eraser, FileText, FlaskConical, Send } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Label,
  PageHeader,
  Segmented,
  Select,
  Textarea,
  type SegmentedOption,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { TIER_HINTS, TIER_LABELS, sourceTypeLabel, type Tier } from "@/lib/ui-labels";

const TIERS: SegmentedOption<Tier>[] = (["fast", "recommended", "max"] as const).map((value) => ({
  value,
  label: TIER_LABELS[value],
}));

/** The composer grows with its text up to this height, then scrolls. */
const MAX_INPUT_HEIGHT = 160;

interface Citation {
  id: string;
  document_id: string;
  source_type: string | null;
  snippet: string;
}
interface Message {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
}

export default function PlaygroundPage() {
  const [tier, setTier] = React.useState<Tier>("recommended");
  const [sourceType, setSourceType] = React.useState<string>("");
  const [sourceTypes, setSourceTypes] = React.useState<string[]>([]);
  const [input, setInput] = React.useState("");
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [streaming, setStreaming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const wasStreaming = React.useRef(false);

  // Populate the source-type filter from the org's documents.
  React.useEffect(() => {
    fetch("/api/admin/playground", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { sourceTypes: [] }))
      .then((json) => setSourceTypes(json.sourceTypes ?? []))
      .catch(() => setSourceTypes([]));
  }, []);

  // Keep the latest message in view as the answer streams in.
  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Grow the composer with its content (capped), and shrink it back after a send.
  React.useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [input]);

  // The composer is disabled while an answer streams; hand focus back afterwards.
  React.useEffect(() => {
    if (wasStreaming.current && !streaming) inputRef.current?.focus();
    wasStreaming.current = streaming;
  }, [streaming]);

  /** Merge a patch into the last (assistant) message. */
  function patchLastAssistant(patch: (m: Message) => Message) {
    setMessages((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].role === "assistant") {
          next[i] = patch(next[i]);
          break;
        }
      }
      return next;
    });
  }

  async function send() {
    const question = input.trim();
    if (!question || streaming) return;

    setError(null);
    setInput("");

    const history: Message[] = [...messages, { role: "user", content: question }];
    // Add the user turn plus an empty assistant turn to stream into.
    setMessages([...history, { role: "assistant", content: "" }]);
    setStreaming(true);

    try {
      const res = await fetch("/api/admin/playground", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.content })),
          model: tier,
          sourceType: sourceType || undefined,
        }),
      });

      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error || `Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;

      // Read NDJSON: parse each complete line as it arrives.
      while (!done) {
        const result = await reader.read();
        done = result.done;
        if (result.value) buffer += decoder.decode(result.value, { stream: true });

        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
          if (!line) continue;

          let evt: { type: string; [k: string]: unknown };
          try {
            evt = JSON.parse(line);
          } catch {
            continue; // ignore a malformed/partial line
          }

          if (evt.type === "citations") {
            const citations = (evt.citations as Citation[]) ?? [];
            patchLastAssistant((m) => ({ ...m, citations }));
          } else if (evt.type === "text") {
            const chunk = String(evt.value ?? "");
            patchLastAssistant((m) => ({ ...m, content: m.content + chunk }));
          } else if (evt.type === "error") {
            setError(String(evt.message ?? "Generation failed."));
          }
        }
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "The request failed. Please try again.");
      // Drop the empty assistant placeholder if nothing streamed.
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.content === "") return prev.slice(0, -1);
        return prev;
      });
    } finally {
      setStreaming(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  /** Clears the on-screen conversation only (nothing is sent or stored). */
  function clear() {
    setMessages([]);
    setError(null);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header + controls (fixed) */}
      <div className="shrink-0 border-b border-border px-4 pt-5 sm:px-6 sm:pt-6">
        <div className="mx-auto w-full max-w-3xl">
          <PageHeader
            className="mb-3"
            title="Playground"
            description="Ask the Brain a question and see the grounded answer and its sources."
            actions={
              <Button
                variant="ghost"
                size="toolbar"
                onClick={clear}
                disabled={streaming || messages.length === 0}
              >
                <Eraser size={14} aria-hidden />
                Clear
              </Button>
            }
          />
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pb-3">
            <div className="flex items-center gap-2">
              <span aria-hidden className="text-xs font-medium text-muted-foreground">
                Model tier
              </span>
              <Segmented label="Model tier" value={tier} options={TIERS} onChange={setTier} />
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="pg-source" className="whitespace-nowrap">
                Source type
              </Label>
              <Select
                id="pg-source"
                density="compact"
                className="w-auto min-w-[9.5rem]"
                value={sourceType}
                onChange={(e) => setSourceType(e.target.value)}
                placeholder="All sources"
                options={sourceTypes.map((s) => ({ value: s, label: sourceTypeLabel(s) }))}
              />
            </div>
            <p className="hidden text-xs text-muted-foreground lg:block">{TIER_HINTS[tier]}</p>
          </div>
        </div>
      </div>

      {/* Transcript (the only scrolling region) */}
      <div
        ref={scrollRef}
        role="log"
        aria-label="Conversation"
        aria-live="polite"
        aria-busy={streaming}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto px-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-6"
      >
        <div
          className={cn(
            "mx-auto w-full max-w-3xl py-4",
            messages.length === 0 ? "flex h-full items-center justify-center" : "space-y-5"
          )}
        >
          {messages.length === 0 ? (
            <EmptyState
              variant="plain"
              icon={FlaskConical}
              title="Ask the Brain anything"
              description="Answers are grounded in retrieved context and cite their sources. Test prompts and model tiers here before wiring a scoped key."
            />
          ) : (
            messages.map((m, i) => (
              <MessageBubble key={i} message={m} streaming={streaming && i === messages.length - 1} />
            ))
          )}
        </div>
      </div>

      {/* Composer (fixed) */}
      <div className="shrink-0 border-t border-border bg-background px-4 py-3 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          {error && (
            <Alert tone="danger" className="mb-2" onDismiss={() => setError(null)}>
              {error}
            </Alert>
          )}
          <div className="flex items-end gap-2 rounded-2xl border border-border bg-surface-muted p-2 transition-[border-color,background-color,box-shadow] duration-200 focus-within:border-accent/35 focus-within:bg-surface focus-within:shadow-float">
            <Label htmlFor="pg-input" className="sr-only">
              Message
            </Label>
            <Textarea
              ref={inputRef}
              id="pg-input"
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask a question…"
              disabled={streaming}
              className="max-h-40 min-h-8 flex-1 resize-none border-0 bg-transparent px-2 py-1 focus-visible:border-transparent focus-visible:ring-0"
            />
            <Button
              size="toolbar"
              onClick={() => void send()}
              loading={streaming}
              disabled={!input.trim()}
              aria-label={streaming ? "Sending" : "Send"}
            >
              {!streaming && <Send size={14} aria-hidden />}
              <span className="hidden sm:inline">{streaming ? "Sending…" : "Send"}</span>
            </Button>
          </div>
          <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">
            Enter to send · Shift+Enter for a new line · Searches the full org with your admin session, not a public key.
          </p>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message, streaming }: { message: Message; streaming: boolean }) {
  if (message.role === "user") {
    return (
      <div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-accent-soft px-4 py-2.5 text-sm leading-6 text-foreground">
        <span className="sr-only">You: </span>
        {message.content}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <BrainCircuit size={14} aria-hidden className="shrink-0 text-accent" />
        Brain
      </div>
      {message.content ? (
        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{message.content}</p>
      ) : streaming ? (
        <span className="inline-flex items-center gap-2 text-[13px] text-muted-foreground">
          <span aria-hidden className="inline-flex items-center gap-1">
            {[0, 1, 2].map((d) => (
              <span
                key={d}
                className="typing-dot h-1.5 w-1.5 rounded-full bg-current"
                style={{ animationDelay: `${d * 0.15}s` }}
              />
            ))}
          </span>
          Thinking…
        </span>
      ) : null}

      {message.citations && message.citations.length > 0 && (
        <details className="group/cites rounded-xl border border-border bg-surface">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight size={14} aria-hidden className="shrink-0 transition-transform group-open/cites:rotate-90" />
            {message.citations.length} source{message.citations.length === 1 ? "" : "s"}
          </summary>
          <ul className="divide-y divide-border border-t border-border">
            {message.citations.map((c) => (
              <li key={c.id} className="space-y-1 px-3 py-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="accent" className="font-mono">
                    <FileText size={12} aria-hidden />
                    {c.id.slice(0, 8)}
                  </Badge>
                  {c.source_type && <Badge tone="neutral">{sourceTypeLabel(c.source_type)}</Badge>}
                </div>
                <p className="text-xs leading-5 text-muted-foreground">{c.snippet}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
