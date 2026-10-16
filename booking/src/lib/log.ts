import { maskPhonesInText } from "./domain/phone";

/** Structured JSON logs. Phone-number-like strings are masked in every message and field. */
export function log(
  level: "info" | "warn" | "error",
  event: string,
  data: Record<string, unknown> = {},
): void {
  const line = maskPhonesInText(JSON.stringify({ t: new Date().toISOString(), level, event, ...data }));
  (level === "error"
    ? console.error
    : level === "warn"
      ? console.warn
      : (s: string) => process.stdout.write(s + "\n"))(line);
}
