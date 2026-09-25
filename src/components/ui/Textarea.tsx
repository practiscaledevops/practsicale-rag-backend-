import * as React from "react";
import { cn } from "@/lib/utils";

/** The chatbot's field recipe for multi-line text. */
export const textareaClass =
  "block w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm leading-6 text-foreground outline-none transition-colors placeholder:text-subtle-foreground focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Monospace 13px for prompts, JSON and code. */
  mono?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, mono = false, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(textareaClass, mono && "font-mono text-[13px] leading-[1.6]", className)}
      {...props}
    />
  )
);
Textarea.displayName = "Textarea";
