"use client";
import {
  useId,
  type ReactNode,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

export async function api<T = unknown>(
  url: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(url, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } } & T;
  if (!res.ok)
    throw new ApiError(
      json.error?.message ?? "Something went wrong. Please try again.",
      json.error?.code ?? "INTERNAL",
      res.status,
    );
  return json;
}
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : "Something went wrong.";

/** Live region so screen readers announce errors/success without moving focus. */
export function Alert({
  kind = "info",
  children,
}: {
  kind?: "error" | "ok" | "info" | "warn";
  children: ReactNode;
}) {
  return (
    <div role={kind === "error" ? "alert" : "status"} className={`alert alert-${kind}`}>
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string, describedBy?: string) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      {children(id, hintId)}
      {hint && (
        <p id={hintId} className="hint">
          {hint}
        </p>
      )}
    </div>
  );
}
export function TextField({
  label,
  hint,
  ...p
}: { label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Field label={label} hint={hint}>
      {(id, d) => <input id={id} aria-describedby={d} className="input" {...p} />}
    </Field>
  );
}
export function SelectField({
  label,
  hint,
  children,
  ...p
}: { label: string; hint?: string } & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <Field label={label} hint={hint}>
      {(id, d) => (
        <select id={id} aria-describedby={d} className="input" {...p}>
          {children}
        </select>
      )}
    </Field>
  );
}
export function TextAreaField({
  label,
  hint,
  ...p
}: { label: string; hint?: string } & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <Field label={label} hint={hint}>
      {(id, d) => <textarea id={id} aria-describedby={d} className="input" rows={3} {...p} />}
    </Field>
  );
}
export function Check({
  label,
  children,
  ...p
}: { label: ReactNode; children?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[var(--brand)]" {...p} />
      <label htmlFor={id} className="text-sm">
        {label}
        {children}
      </label>
    </div>
  );
}
export const newKey = (): string => crypto.randomUUID();
