"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Label } from "./Label";

export interface FieldProps {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  /** Id of the control; defaults to the child's own id, else a generated one. */
  htmlFor?: string;
  /** Shows a required marker. It does not set `required` on the control (pass that yourself). */
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}

type ControlProps = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
};

/**
 * Label + control + hint/error, bound for assistive tech: the label's htmlFor
 * matches the control's id, and the hint/error are wired through
 * aria-describedby (plus aria-invalid on error). Pass a single control element
 * as the child to get the automatic binding.
 */
export function Field({ label, hint, error, htmlFor, required, className, children }: FieldProps) {
  const autoId = React.useId();
  const single = React.Children.count(children) === 1 && React.isValidElement<ControlProps>(children) ? children : null;
  const id = htmlFor ?? single?.props.id ?? `field-${autoId}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  let control = children;
  if (single) {
    const describedBy = [single.props["aria-describedby"], hintId, errorId].filter(Boolean).join(" ") || undefined;
    control = React.cloneElement(single, {
      id,
      "aria-describedby": describedBy,
      ...(error ? { "aria-invalid": true } : null),
    });
  }

  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>
        {label}
        {required && (
          <span className="ml-0.5 text-danger" aria-hidden>
            *
          </span>
        )}
      </Label>
      {control}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
