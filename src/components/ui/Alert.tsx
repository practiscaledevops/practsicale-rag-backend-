"use client";

import * as React from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { IconButton } from "./IconButton";

export type AlertTone = "info" | "success" | "warning" | "danger";

const TONES: Record<AlertTone, { box: string; icon: string; Icon: LucideIcon }> = {
  info: { box: "border-info/30 bg-info/10 text-foreground", icon: "text-info", Icon: Info },
  success: { box: "border-success/30 bg-success/10 text-foreground", icon: "text-success", Icon: CheckCircle2 },
  warning: { box: "border-warning/30 bg-warning/10 text-foreground", icon: "text-warning", Icon: AlertTriangle },
  danger: { box: "border-danger/30 bg-danger/10 text-danger-ink", icon: "text-danger", Icon: AlertCircle },
};

export interface AlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  tone?: AlertTone;
  title?: React.ReactNode;
  /** Shows a dismiss (X) button. */
  onDismiss?: () => void;
}

/**
 * Inline banner for page and form feedback (stands in for toasts, as in the
 * chatbot). danger/warning announce as role="alert", info/success as "status".
 */
export function Alert({ className, tone = "info", title, onDismiss, children, role, ...props }: AlertProps) {
  const { box, icon, Icon } = TONES[tone];
  const urgent = tone === "danger" || tone === "warning";
  return (
    <div
      role={role ?? (urgent ? "alert" : "status")}
      className={cn("flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px]", box, className)}
      {...props}
    >
      <Icon size={16} aria-hidden className={cn("mt-0.5 shrink-0", icon)} />
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && (
          <div
            className={cn(
              title && "mt-0.5",
              // Danger body stays full-strength danger ink for AA (text-danger/80 on the tint is ~3.3:1).
              tone === "danger" ? "text-danger-ink" : title && "text-muted-foreground"
            )}
          >
            {children}
          </div>
        )}
      </div>
      {onDismiss && (
        <IconButton aria-label="Dismiss" size="sm" onClick={onDismiss} className="-my-1 -mr-1.5 text-current">
          <X size={14} aria-hidden />
        </IconButton>
      )}
    </div>
  );
}

/** Auto-dismissing success/info notice (calls onDone after timeoutMs). */
export function Notice({
  tone = "success",
  message,
  onDone,
  timeoutMs = 4000,
  className,
}: {
  tone?: AlertTone;
  message: React.ReactNode;
  onDone?: () => void;
  timeoutMs?: number;
  className?: string;
}) {
  const onDoneRef = React.useRef(onDone);
  React.useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);
  React.useEffect(() => {
    if (!message || timeoutMs <= 0) return;
    const t = window.setTimeout(() => onDoneRef.current?.(), timeoutMs);
    return () => window.clearTimeout(t);
  }, [message, timeoutMs]);
  if (!message) return null;
  return (
    <Alert tone={tone} onDismiss={onDone} className={className}>
      {message}
    </Alert>
  );
}

/** Field-level error text; renders nothing when there is no message. */
export function InlineError({ message, className }: { message?: string | null; className?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className={cn("text-xs text-danger", className)}>
      {message}
    </p>
  );
}
