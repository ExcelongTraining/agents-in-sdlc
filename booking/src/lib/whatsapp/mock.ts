import { randomUUID } from "node:crypto";
import type { ButtonOption, ListRow, SendResult, WhatsAppProvider } from "./provider";

export interface SentMessage {
  to: string;
  kind: "text" | "buttons" | "list" | "template";
  body?: string;
  template?: string;
  params?: string[];
  buttons?: ButtonOption[];
  rows?: ListRow[];
  id: string;
}

/** Sends nothing. Records messages in memory and can simulate provider failures for retry tests. */
export class MockWhatsAppProvider implements WhatsAppProvider {
  readonly name = "mock";
  readonly sent: SentMessage[] = [];
  private failures: { retryable: boolean; error: string }[] = [];

  failNext(count: number, retryable = true, error = "mock failure"): void {
    for (let i = 0; i < count; i++) this.failures.push({ retryable, error });
  }
  reset(): void {
    this.sent.length = 0;
    this.failures = [];
  }
  private record(m: Omit<SentMessage, "id">): SendResult {
    const f = this.failures.shift();
    if (f) return { ok: false, retryable: f.retryable, error: f.error };
    const id = `wamid.mock.${randomUUID()}`;
    this.sent.push({ ...m, id });
    return { ok: true, messageId: id };
  }
  async sendText(to: string, body: string): Promise<SendResult> {
    return this.record({ to, kind: "text", body });
  }
  async sendButtons(to: string, body: string, buttons: ButtonOption[]): Promise<SendResult> {
    return this.record({ to, kind: "buttons", body, buttons });
  }
  async sendList(to: string, body: string, _label: string, rows: ListRow[]): Promise<SendResult> {
    return this.record({ to, kind: "list", body, rows });
  }
  async sendTemplate(to: string, template: string, _language: string, params: string[]): Promise<SendResult> {
    return this.record({ to, kind: "template", template, params });
  }
}
