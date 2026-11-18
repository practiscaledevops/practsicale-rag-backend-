// A canned, grounded-looking streamed answer for DEMO MODE, emitted in the
// Vercel AI SDK v4 data-stream protocol so useChat() renders it like the real
// thing (token-by-token, with a citation chip).

import type { SavedAnswerSource } from "@/lib/saved-answer-followup";

export const demoSavedAnswerSources: readonly SavedAnswerSource[] = [
  {
    id: "3b1aaf21-7192-4dbf-91c1-95958bdf302b",
    document_id: "3b1aaf21-7192-4dbf-91c1-95958bdf302a",
    content: "Send the first reminder 24 hours before the appointment.",
    documents: { title: "Appointment Reminder Playbook", created_at: "2026-10-25T12:00:00Z", updated_at: null },
  },
  {
    id: "8cd8e503-34f1-4da0-a105-536d76336c2b",
    document_id: "8cd8e503-34f1-4da0-a105-536d76336c2a",
    content: "If the buyer has not confirmed, send a second reminder 2 hours before the appointment. The second reminder is for unconfirmed appointments so buyers who have already confirmed do not receive another reminder.",
    documents: { title: "Confirmation Follow-up Guide", created_at: "2026-10-26T12:00:00Z", updated_at: null },
  },
  {
    id: "7fc78cab-be13-4176-9467-cc363c99736b",
    document_id: "7fc78cab-be13-4176-9467-cc363c99736a",
    content: "Track show-up rate weekly using attended appointments divided by scheduled appointments.",
    documents: { title: "Show-up Rate Definitions", created_at: "2026-10-27T12:00:00Z", updated_at: null },
  },
];

export function demoAnswerText(query: string): string {
  return pickAnswer(query);
}

function pickAnswer(query: string): string {
  const q = (query || "").toLowerCase();
  if (q.includes("discovery") || q.includes("improve") || q.includes("weak")) {
    return "Based on the call-scoring data, reps score highest on closing (avg 84/100) and lowest on discovery (avg 61/100). The coaching notes suggest mirroring the customer's stated priority in the first two minutes, which correlates with a 23% higher close rate. Recommendation: tighten discovery questioning before pitching. [demo-chunk-1] [demo-chunk-2]";
  }
  if (q.includes("nemt") || q.includes("playbook") || q.includes("pitch")) {
    return "For NEMT accounts, lead with reliability and on-time performance — facility coordinators treat price as secondary. Open with a proof point on on-time rate, then handle the reliability objection directly. [demo-chunk-3]";
  }
  return "Here's what the knowledge base shows: reps close best when they lead with the customer's stated priority and keep discovery tight. Closing scores average 84/100 while discovery lags at 61/100, so the biggest lever is stronger discovery questioning. [demo-chunk-1] [demo-chunk-2]";
}

export function demoChatStreamResponse(query: string): Response {
  const text = pickAnswer(query);
  const tokens = text.match(/\S+\s*/g) ?? [text];
  const enc = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const tok of tokens) {
        controller.enqueue(enc.encode(`0:${JSON.stringify(tok)}\n`));
        // small delay to simulate streaming
        await new Promise((r) => setTimeout(r, 22));
      }
      const usage = { promptTokens: 1200, completionTokens: tokens.length };
      controller.enqueue(
        enc.encode(`d:${JSON.stringify({ finishReason: "stop", usage })}\n`)
      );
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-vercel-ai-data-stream": "v1",
    },
  });
}
