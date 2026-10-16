/**
 * Normalise a WhatsApp Cloud API webhook body into events. Parsing is defensive: unknown shapes are ignored, never thrown.
 * Shape: { entry: [{ changes: [{ value: { contacts: [...], messages: [...], statuses: [...] } }] }] }
 */
export type InboundEvent =
  | { kind: "message"; key: string; waMessageId: string; from: string; name?: string; type: string; text?: string; replyId?: string; timestamp: Date }
  | { kind: "status"; key: string; waMessageId: string; recipient?: string; status: "sent" | "delivered" | "read" | "failed"; errorText?: string; timestamp: Date };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const ts = (v: unknown): Date => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
};

export function parseWebhook(body: unknown): InboundEvent[] {
  const out: InboundEvent[] = [];
  if (!isObj(body)) return out;
  for (const entry of arr(body.entry)) {
    for (const change of arr(entry.changes)) {
      const value = change.value;
      if (!isObj(value)) continue;
      const names = new Map<string, string>();
      for (const c of arr(value.contacts)) {
        const id = str(c.wa_id);
        const nm = isObj(c.profile) ? str(c.profile.name) : undefined;
        if (id && nm) names.set(id, nm);
      }
      for (const m of arr(value.messages)) {
        const id = str(m.id);
        const from = str(m.from);
        const type = str(m.type) ?? "unknown";
        if (!id || !from) continue;
        let text: string | undefined;
        let replyId: string | undefined;
        if (type === "text" && isObj(m.text)) text = str(m.text.body);
        if (type === "interactive" && isObj(m.interactive)) {
          const br = m.interactive.button_reply;
          const lr = m.interactive.list_reply;
          if (isObj(br)) { replyId = str(br.id); text = str(br.title); }
          if (isObj(lr)) { replyId = str(lr.id); text = str(lr.title); }
        }
        if (type === "button" && isObj(m.button)) { replyId = str(m.button.payload); text = str(m.button.text); }
        out.push({ kind: "message", key: `msg:${id}`, waMessageId: id, from, name: names.get(from), type, text, replyId, timestamp: ts(m.timestamp) });
      }
      for (const s of arr(value.statuses)) {
        const id = str(s.id);
        const status = str(s.status);
        if (!id || !(status === "sent" || status === "delivered" || status === "read" || status === "failed")) continue;
        const e0 = arr(s.errors)[0];
        out.push({
          kind: "status", key: `status:${id}:${status}`, waMessageId: id, recipient: str(s.recipient_id), status,
          errorText: e0 ? `${e0.code ?? ""} ${str(e0.title) ?? str(e0.message) ?? ""}`.trim() : undefined, timestamp: ts(s.timestamp),
        });
      }
    }
  }
  return out;
}
