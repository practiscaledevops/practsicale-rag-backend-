import * as React from "react";
import { AlertCircle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

type Tone = "info" | "success" | "warning" | "danger";

const config: Record<Tone, { className: string; Icon: typeof Info }> = {
  info: { className: "border-accent/30 bg-accent/5 text-foreground", Icon: Info },
  success: {
    className: "border-success/30 bg-success/5 text-foreground",
    Icon: CheckCircle2,
  },
  warning: {
    className: "border-warning/30 bg-warning/5 text-foreground",
    Icon: AlertCircle,
  },
  danger: {
    className: "border-danger/30 bg-danger/5 text-foreground",
    Icon: XCircle,
  },
};

const iconTone: Record<Tone, string> = {
  info: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: Tone;
  title?: string;
}

/**
 * Inline alert for form feedback and page-level notices. Keeps feedback in the
 * DOM (accessible via role="alert") rather than a floating toast, which suits a
 * back-office tool. Compose your own toast later if needed.
 */
export function Alert({
  className,
  tone = "info",
  title,
  children,
  ...props
}: AlertProps) {
  const { className: toneClass, Icon } = config[tone];
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3 text-sm",
        toneClass,
        className
      )}
      {...props}
    >
      <Icon
        className={cn("mt-0.5 h-4 w-4 shrink-0", iconTone[tone])}
        aria-hidden="true"
      />
      <div className="min-w-0">
        {title && <p className="font-medium">{title}</p>}
        {children && (
          <div className={cn(title && "mt-0.5", "text-muted-foreground")}>
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
