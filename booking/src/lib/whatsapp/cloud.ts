import { env } from "../config/env";
import { maskPhonesInText, e164ToWaId } from "../domain/phone";
import type { ButtonOption, ListRow, SendResult, WhatsAppProvider } from "./provider";

/**
 * Official WhatsApp Business Platform Cloud API (Graph API). POST /{phone-number-id}/messages with a Bearer token.
 * Payload shapes follow Meta's published reference; verify them against the current docs before go-live
 * (see docs/whatsapp-integration.md, "Verification checklist"). The access token is read server-side only.
 */
export class CloudApiProvider implements WhatsAppProvider {
  readonly name = "cloud";

  private async post(body: Record<string, unknown>): Promise<SendResult> {
    const e = env();
    const url = `https://graph.facebook.com/${e.WHATSAPP_GRAPH_VERSION}/${e.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${e.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...body }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      return { ok: false, retryable: true, error: `network: ${(err as Error).name}` };
    }
    const text = await res.text();
    if (res.ok) {
      try {
        const id = (JSON.parse(text) as { messages?: { id?: string }[] }).messages?.[0]?.id;
        if (id) return { ok: true, messageId: id };
      } catch {
        /* fall through */
      }
      return { ok: false, retryable: false, error: "unexpected success response shape" };
    }
    // 429 and 5xx are transient. 4xx (invalid number, template not approved, outside window, bad token) will not fix themselves.
    const retryable = res.status === 429 || res.status >= 500;
    let detail = "";
    try {
      const err = (JSON.parse(text) as { error?: { code?: number; message?: string } }).error;
      detail = `${err?.code ?? ""} ${err?.message ?? ""}`.trim();
    } catch {
      detail = text.slice(0, 120);
    }
    return { ok: false, retryable, error: maskPhonesInText(`http ${res.status} ${detail}`).slice(0, 300) };
  }

  sendText(to: string, body: string): Promise<SendResult> {
    return this.post({ to: e164ToWaId(to), type: "text", text: { preview_url: false, body } });
  }
  sendButtons(to: string, body: string, buttons: ButtonOption[]): Promise<SendResult> {
    return this.post({
      to: e164ToWaId(to), type: "interactive",
      interactive: { type: "button", body: { text: body }, action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) } },
    });
  }
  sendList(to: string, body: string, buttonLabel: string, rows: ListRow[]): Promise<SendResult> {
    return this.post({
      to: e164ToWaId(to), type: "interactive",
      interactive: {
        type: "list", body: { text: body },
        action: { button: buttonLabel.slice(0, 20), sections: [{ title: "Options", rows: rows.slice(0, 10).map((r) => ({ id: r.id, title: r.title.slice(0, 24), ...(r.description ? { description: r.description.slice(0, 72) } : {}) })) }] },
      },
    });
  }
  sendTemplate(to: string, templateName: string, language: string, params: string[]): Promise<SendResult> {
    return this.post({
      to: e164ToWaId(to), type: "template",
      template: {
        name: templateName, language: { code: language },
        components: params.length ? [{ type: "body", parameters: params.map((p) => ({ type: "text", text: p })) }] : [],
      },
    });
  }
}
