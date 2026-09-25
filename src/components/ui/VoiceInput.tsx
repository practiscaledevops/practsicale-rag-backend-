"use client";

// Voice dictation button for the Operating Intelligence screens. Records in the
// browser with MediaRecorder, POSTs the audio to /api/admin/knowledge/voice
// (which transcribes it), and hands the transcript back through `onText`. If
// MediaRecorder / getUserMedia are unavailable the button hides itself. The mic
// stream is always released on stop / unmount so it never stays on.

import * as React from "react";
import { Mic, Square } from "lucide-react";
import { Button } from "./Button";
import { InlineError } from "./Alert";
import { Spinner } from "./Loading";
import {
  AUTO_STOP_MS,
  MIN_RECORDING_MS,
  fileNameForMime,
  formatElapsed,
  overUploadLimit,
  pickRecorderMimeType,
} from "@/lib/voice-shared";

type Phase = "idle" | "recording" | "transcribing";

export interface VoiceInputProps {
  /** Called with the transcript once transcription succeeds. */
  onText: (text: string) => void;
  /** POST target that returns `{ text }` (defaults to the knowledge voice route). */
  endpoint?: string;
  /** Idle button label. */
  label?: string;
  disabled?: boolean;
  className?: string;
}

const PERMISSION_MESSAGE =
  "Microphone access was blocked — allow it in your browser's site settings.";

export function VoiceInput({
  onText,
  endpoint = "/api/admin/knowledge/voice",
  label = "Dictate",
  disabled,
  className,
}: VoiceInputProps) {
  const [supported, setSupported] = React.useState(false);
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [elapsed, setElapsed] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const mimeRef = React.useRef<string>("");
  const startedAtRef = React.useRef(0);
  const tickRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortUploadRef = React.useRef(false);

  // Feature-detect after mount — SSR has no navigator / MediaRecorder. Rendering
  // nothing until confirmed matches the server output (no hydration mismatch).
  React.useEffect(() => {
    setSupported(
      typeof window !== "undefined" &&
        typeof MediaRecorder !== "undefined" &&
        !!navigator.mediaDevices?.getUserMedia
    );
  }, []);

  const clearTimers = React.useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (autoStopRef.current) {
      clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
  }, []);

  const releaseStream = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const upload = React.useCallback(
    async (blob: Blob) => {
      setPhase("transcribing");
      try {
        const fd = new FormData();
        fd.append("file", blob, fileNameForMime(mimeRef.current));
        const res = await fetch(endpoint, { method: "POST", body: fd });
        const json = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
        if (!res.ok) {
          throw new Error(typeof json.error === "string" ? json.error : "Transcription failed.");
        }
        const text = (json.text ?? "").trim();
        if (text) onText(text);
        else setError("No speech detected in the recording.");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Transcription failed.");
      } finally {
        setPhase("idle");
      }
    },
    [endpoint, onText]
  );

  const handleStop = React.useCallback(() => {
    clearTimers();
    releaseStream();
    const durationMs = Date.now() - startedAtRef.current;
    const chunks = chunksRef.current;
    chunksRef.current = [];
    const blob = new Blob(chunks, { type: mimeRef.current || "audio/webm" });

    if (abortUploadRef.current) {
      abortUploadRef.current = false;
      setPhase("idle");
      return;
    }
    if (durationMs < MIN_RECORDING_MS || blob.size === 0) {
      setPhase("idle");
      return;
    }
    if (overUploadLimit(blob.size)) {
      setError("Recording too long — keep dictation under a few minutes.");
      setPhase("idle");
      return;
    }
    void upload(blob);
  }, [clearTimers, releaseStream, upload]);

  const stopRecording = React.useCallback(() => {
    clearTimers();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    } else {
      releaseStream();
      setPhase("idle");
    }
  }, [clearTimers, releaseStream]);

  const start = React.useCallback(async () => {
    setError(null);
    setNote(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") setError(PERMISSION_MESSAGE);
      else if (name === "NotFoundError" || name === "DevicesNotFoundError")
        setError("No microphone was found.");
      else setError(e instanceof Error ? e.message : "Couldn't start recording.");
      return;
    }
    streamRef.current = stream;
    try {
      const mimeType = pickRecorderMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      mimeRef.current = recorder.mimeType || mimeType || "audio/webm";
      chunksRef.current = [];
      abortUploadRef.current = false;
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = handleStop;
      recorder.start();
      startedAtRef.current = Date.now();
      setElapsed(0);
      setPhase("recording");
      tickRef.current = setInterval(() => setElapsed(Date.now() - startedAtRef.current), 200);
      autoStopRef.current = setTimeout(() => {
        setNote("Reached the 5-minute limit — transcribing what you recorded.");
        stopRecording();
      }, AUTO_STOP_MS);
    } catch (e) {
      releaseStream();
      setPhase("idle");
      setError(e instanceof Error ? e.message : "Couldn't start recording.");
    }
  }, [handleStop, releaseStream, stopRecording]);

  const toggle = React.useCallback(() => {
    if (phase === "recording") stopRecording();
    else if (phase === "idle") void start();
  }, [phase, start, stopRecording]);

  React.useEffect(() => {
    return () => {
      abortUploadRef.current = true;
      clearTimers();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          /* ignore */
        }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [clearTimers]);

  if (!supported) return null;

  const recording = phase === "recording";
  const transcribing = phase === "transcribing";

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={recording ? "danger-secondary" : "secondary"}
          size="toolbar"
          onClick={toggle}
          disabled={disabled || transcribing}
          aria-label={recording ? "Stop recording" : `${label}: start recording`}
          aria-pressed={recording}
        >
          {recording ? <Square size={12} aria-hidden className="fill-current" /> : <Mic size={14} aria-hidden />}
          {recording ? "Stop" : label}
        </Button>
        {recording && (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-2 rounded-full bg-danger motion-safe:animate-pulse" />
            <span className="text-xs tabular-nums text-muted-foreground">
              <span className="sr-only">Recording, </span>
              {formatElapsed(elapsed)}
            </span>
          </span>
        )}
        {transcribing && <Spinner label="Transcribing…" className="py-0 text-xs" />}
      </div>
      {note && !error && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
      <InlineError message={error} className="mt-1" />
    </div>
  );
}
