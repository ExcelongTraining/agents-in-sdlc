import { withTx } from "../db/tx";
import { AppError } from "../errors";
import { maskPhone, waIdToE164 } from "../domain/phone";
import { requirePermission, type Principal } from "../domain/rbac";
import { getProvider } from "../whatsapp/provider";
import { ctxFor } from "./booking";
import { staffCtx } from "./schedule";
import { loadSettings } from "./settings";

export interface HandoffRow {
  id: string;
  contactName: string | null;
  phoneMasked: string;
  handoff: string;
  lastActivityAt: string;
  windowOpen: boolean;
  messages: { direction: string; body: string | null; at: string }[];
}

export async function listHandoffs(p: Principal): Promise<HandoffRow[]> {
  requirePermission(p, "customers.read");
  return withTx(staffCtx(p), async (tx) => {
    const s = await loadSettings(tx);
    const convs = await tx.query<{
      id: string;
      profile_name: string | null;
      wa_id: string;
      handoff_status: string;
      last_activity_at: Date;
      last_inbound_at: Date | null;
    }>(
      `select v.id, c.profile_name, c.wa_id, v.handoff_status, v.last_activity_at, c.last_inbound_at from whatsapp_conversations v join whatsapp_contacts c on c.id = v.contact_id
        where v.handoff_status in ('requested','human') order by v.handoff_requested_at nulls last limit 50`,
    );
    const out: HandoffRow[] = [];
    for (const v of convs) {
      const msgs = await tx.query<{ direction: string; body: string | null; occurred_at: Date }>(
        "select direction, body, occurred_at from whatsapp_messages where conversation_id = $1 order by occurred_at desc limit 8",
        [v.id],
      );
      out.push({
        id: v.id,
        contactName: v.profile_name,
        phoneMasked: maskPhone(waIdToE164(v.wa_id)),
        handoff: v.handoff_status,
        lastActivityAt: v.last_activity_at.toISOString(),
        windowOpen:
          !!v.last_inbound_at && Date.now() - v.last_inbound_at.getTime() < s.whatsapp.windowHours * 3600_000,
        messages: msgs
          .reverse()
          .map((m) => ({ direction: m.direction, body: m.body, at: m.occurred_at.toISOString() })),
      });
    }
    return out;
  });
}

/** Manager replies as a human. Allowed only while the 24-hour customer-service window is open (otherwise a template is required). */
export async function replyToConversation(p: Principal, conversationId: string, text: string): Promise<void> {
  requirePermission(p, "customers.read");
  const body = text.trim();
  if (body.length < 1 || body.length > 1000)
    throw new AppError("VALIDATION", "Write a message of up to 1000 characters.");
  const target = await withTx(ctxFor(p.orgId, { kind: "staff", principal: p }), async (tx) => {
    const s = await loadSettings(tx);
    const c = await tx.maybeOne<{ wa_id: string; last_inbound_at: Date | null; id: string }>(
      "select c.wa_id, c.last_inbound_at, v.id from whatsapp_conversations v join whatsapp_contacts c on c.id = v.contact_id where v.id = $1",
      [conversationId],
    );
    if (!c) throw new AppError("NOT_FOUND", "Conversation not found.");
    if (!c.last_inbound_at || Date.now() - c.last_inbound_at.getTime() >= s.whatsapp.windowHours * 3600_000)
      throw new AppError(
        "NOT_ALLOWED",
        "The 24-hour WhatsApp window has closed. Phone the customer instead.",
      );
    await tx.query(
      "update whatsapp_conversations set handoff_status = 'human', assigned_manager_id = $2 where id = $1",
      [conversationId, p.userId],
    );
    return c;
  });
  const r = await getProvider().sendText(waIdToE164(target.wa_id), body);
  if (!r.ok)
    throw new AppError("PROVIDER_ERROR", "WhatsApp could not deliver the message. Try again shortly.", {
      internal: r.error,
    });
  await withTx(ctxFor(p.orgId, { kind: "staff", principal: p }), (tx) =>
    tx.query(
      `insert into whatsapp_messages(organisation_id, conversation_id, contact_id, direction, provider_message_id, msg_type, body, status)
       select $1, v.id, v.contact_id, 'outbound', $3, 'text', $4, 'sent' from whatsapp_conversations v where v.id = $2`,
      [p.orgId, conversationId, r.messageId, body],
    ),
  );
}

export async function resolveHandoff(p: Principal, conversationId: string): Promise<void> {
  requirePermission(p, "customers.read");
  await withTx(staffCtx(p), async (tx) => {
    const r = await tx.query(
      "update whatsapp_conversations set handoff_status = 'bot', state = 'idle', context = '{}' where id = $1 returning id",
      [conversationId],
    );
    if (!r.length) throw new AppError("NOT_FOUND", "Conversation not found.");
  });
}
