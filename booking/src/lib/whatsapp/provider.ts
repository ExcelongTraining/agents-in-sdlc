import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env";
import { MockWhatsAppProvider } from "./mock";
import { CloudApiProvider } from "./cloud";

export type SendResult = { ok: true; messageId: string } | { ok: false; retryable: boolean; error: string };

export interface ButtonOption {
  id: string;
  title: string; // WhatsApp limit: 20 chars
}
export interface ListRow {
  id: string;
  title: string; // limit 24 chars
  description?: string; // limit 72 chars
}

/**
 * Everything the application needs from WhatsApp. Two implementations: MockWhatsAppProvider (development/tests, sends
 * nothing) and CloudApiProvider (official WhatsApp Business Platform Cloud API). Business code never imports either.
 */
export interface WhatsAppProvider {
  readonly name: string;
  sendText(toE164: string, body: string): Promise<SendResult>;
  sendButtons(toE164: string, body: string, buttons: ButtonOption[]): Promise<SendResult>;
  sendList(toE164: string, body: string, buttonLabel: string, rows: ListRow[]): Promise<SendResult>;
  /** `params` fill the template body placeholders in order. */
  sendTemplate(toE164: string, templateName: string, language: string, params: string[]): Promise<SendResult>;
}

let override: WhatsAppProvider | undefined;
let instance: WhatsAppProvider | undefined;

export function getProvider(): WhatsAppProvider {
  if (override) return override;
  if (!instance)
    instance = env().WHATSAPP_PROVIDER === "cloud" ? new CloudApiProvider() : new MockWhatsAppProvider();
  return instance;
}
export function setProviderForTests(p: WhatsAppProvider | undefined): void {
  override = p;
}

/** Verify Meta's X-Hub-Signature-256 ("sha256=<hex>") over the RAW request body with the app secret. Constant time. */
export function verifySignature(
  rawBody: string,
  header: string | null | undefined,
  appSecret: string,
): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const given = header.slice("sha256=".length);
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
