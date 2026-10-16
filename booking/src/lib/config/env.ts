import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z.enum(["true", "false"]).default("false"),
  APP_BASE_URL: z.url().default("http://localhost:3000"),
  /** Used to sign manage-link tokens' HMAC and CSRF-adjacent values. At least 32 chars. */
  APP_SECRET: z.string().min(32),
  CRON_SECRET: z.string().min(16).optional(),
  /** Organisation slug served by this deployment (single-tenant deployment; schema is multi-tenant). */
  ORG_SLUG: z.string().default("lotus-demo"),
  WHATSAPP_PROVIDER: z.enum(["mock", "cloud"]).default("mock"),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_GRAPH_VERSION: z.string().default("v23.0"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Validated, server-only environment. Throws a readable error listing missing variables (never their values). */
export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid or missing environment variables: ${names}`);
  }
  const e = parsed.data;
  if (e.WHATSAPP_PROVIDER === "cloud") {
    const missing = ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"].filter(
      (k) => !process.env[k],
    );
    if (missing.length) throw new Error(`WHATSAPP_PROVIDER=cloud requires: ${missing.join(", ")}`);
  }
  if (e.NODE_ENV === "production" && !e.CRON_SECRET) throw new Error("CRON_SECRET is required in production");
  cached = e;
  return e;
}

export function resetEnvCacheForTests(): void {
  cached = undefined;
}
