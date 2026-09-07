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

import * as React from "react";
import { FlaskConical, Send, User, Sparkles, FileText } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import { Label } from "@/components/ui/Label";
import { cn } from "@/lib/utils";

type Tier = "fast" | "recommended" | "max";
const TIERS: { value: Tier; label: string }[] = [
  { value: "fast", label: "Fast" },
  { value: "recommended", label: "Recommended" },
  { value: "max", label: "Max" },
];

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

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col">
      <PageHeader
        title="Playground"
        description="Internal grounded chat over the full org. Not a public key — admin session only."
      />

      {/* Controls */}
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div>
          <Label className="mb-1.5 block">Model tier</Label>
          <div
            className="inline-flex rounded-lg border border-border bg-surface p-0.5"
            role="group"
            aria-label="Model tier"
          >
            {TIERS.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setTier(t.value)}
                aria-pressed={tier === t.value}
                className={cn(
                  "rounded-md px-3 py-1 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  tier === t.value
                    ? "bg-accent/10 text-accent"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <Label htmlFor="pg-source" className="mb-1.5 block">
            Source type
          </Label>
          <select
            id="pg-source"
            value={sourceType}
            onChange={(e) => setSourceType(e.target.value)}
            className={cn(
              "h-9 rounded-lg border border-border bg-surface px-3 text-sm",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            )}
          >
            <option value="">All sources</option>
            {sourceTypes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Conversation */}
      <Card className="flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-surface-muted">
                <FlaskConical className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
              </div>
              <p className="text-sm font-medium">Ask the Brain anything</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Answers are grounded in retrieved context and cite their sources. Test prompts and
                model tiers here before wiring a scoped key.
              </p>
            </div>
          ) : (
            messages.map((m, i) => <MessageBubble key={i} message={m} streaming={streaming && i === messages.length - 1} />)
          )}
        </div>

        {error && (
          <div className="px-5 pb-3">
            <Alert tone="danger">{error}</Alert>
          </div>
        )}

        {/* Composer */}
        <CardContent className="border-t border-border p-4 pt-4">
          <div className="flex items-end gap-2">
            <label htmlFor="pg-input" className="sr-only">
              Message
            </label>
            <textarea
              id="pg-input"
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask a question…  (Enter to send, Shift+Enter for a new line)"
              disabled={streaming}
              className={cn(
                "flex max-h-40 min-h-[2.25rem] w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-sm",
                "placeholder:text-muted-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                "disabled:cursor-not-allowed disabled:opacity-50"
              )}
            />
            <Button onClick={() => void send()} disabled={streaming || !input.trim()}>
              <Send className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">{streaming ? "Sending…" : "Send"}</span>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function MessageBubble({ message, streaming }: { message: Message; streaming: boolean }) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex gap-3", isUser && "flex-row-reverse")}>
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          isUser ? "bg-accent/10 text-accent" : "bg-surface-muted text-muted-foreground"
        )}
        aria-hidden="true"
      >
        {isUser ? <User className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
      </div>
      <div className={cn("min-w-0 max-w-[80%] space-y-2", isUser && "items-end")}>
        <div
          className={cn(
            "rounded-xl px-4 py-2.5 text-sm",
            isUser ? "bg-accent text-accent-foreground" : "bg-surface-muted text-foreground"
          )}
        >
          {message.content ? (
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
          ) : streaming ? (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
              Thinking…
            </span>
          ) : null}
        </div>

        {message.citations && message.citations.length > 0 && (
          <details className="rounded-lg border border-border bg-surface px-3 py-2 text-sm">
            <summary className="cursor-pointer select-none font-medium text-muted-foreground">
              {message.citations.length} source{message.citations.length === 1 ? "" : "s"}
            </summary>
            <ul className="mt-2 space-y-2">
              {message.citations.map((c) => (
                <li key={c.id} className="rounded-md bg-surface-muted p-2">
                  <div className="mb-1 flex items-center gap-2">
                    <FileText className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                    <code className="text-xs text-muted-foreground">[{c.id.slice(0, 8)}]</code>
                    {c.source_type && <Badge tone="neutral">{c.source_type}</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground">{c.snippet}</p>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
