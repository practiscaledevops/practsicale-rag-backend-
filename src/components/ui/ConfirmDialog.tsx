"use client";

import * as React from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { InlineError } from "./Alert";

export interface ConfirmDialogProps {
  open: boolean;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" for destructive actions (red confirm button). */
  tone?: "default" | "danger";
  /** While true the confirm button spins and the dialog can't be dismissed. */
  busy?: boolean;
  /** Shown under the body, e.g. the server's error from a failed delete. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  /** Focus target on close when the opener is gone (see Dialog). */
  returnFocus?: () => HTMLElement | null | undefined;
}

/**
 * Confirmation step for destructive or org-wide actions (the chatbot's delete
 * dialog). Replaces the native browser prompt; focus starts on Cancel.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  busy = false,
  error,
  onConfirm,
  onCancel,
  returnFocus,
}: ConfirmDialogProps) {
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const body =
    children || error ? (
      <>
        {children && <div className="text-[13px] text-muted-foreground">{children}</div>}
        <InlineError message={error} className={children ? "mt-3" : undefined} />
      </>
    ) : null;

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      size="sm"
      dismissible={!busy}
      initialFocusRef={cancelRef}
      returnFocus={returnFocus}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" size="toolbar" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} size="toolbar" loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body}
    </Dialog>
  );
}

export interface ConfirmOptions {
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
}

/**
 * Promise-based drop-in for the native browser prompt:
 *
 *   const { confirm, dialog } = useConfirm();
 *   if (!(await confirm({ title: "Delete source?", tone: "danger", confirmLabel: "Delete" }))) return;
 *   ...
 *   return <>{...}{dialog}</>;
 *
 * Render {dialog} once. Resolves true on confirm, false on cancel / Escape /
 * backdrop, and false for a pending prompt when a new one opens or on unmount.
 */
export function useConfirm(): {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  dialog: React.ReactNode;
} {
  const [opts, setOpts] = React.useState<ConfirmOptions | null>(null);
  const resolver = React.useRef<((ok: boolean) => void) | null>(null);

  const settle = React.useCallback((ok: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setOpts(null);
    resolve?.(ok);
  }, []);

  const confirm = React.useCallback(
    (next: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setOpts(next);
      }),
    []
  );

  React.useEffect(
    () => () => {
      resolver.current?.(false);
      resolver.current = null;
    },
    []
  );

  const dialog = (
    <ConfirmDialog
      open={opts !== null}
      title={opts?.title ?? ""}
      description={opts?.description}
      confirmLabel={opts?.confirmLabel}
      cancelLabel={opts?.cancelLabel}
      tone={opts?.tone}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );

  return { confirm, dialog };
}
