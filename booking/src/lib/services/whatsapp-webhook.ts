import { withTx } from "../db/tx";
import { env } from "../config/env";
import { AppError } from "../errors";
import { log } from "../log";
import { waIdToE164, maskPhonesInText } from "../domain/phone";
import { parseWebhook, type InboundEvent } from "../whatsapp/inbound";
import { getProvider, verifySignature } from "../whatsapp/provider";
import { handleIncoming, type Action } from "./whatsapp-conversation";
import { getOrgId } from "./org";
import { systemClock, type Clock } from "./booking-shared";

const MAX_ATTEMPTS = 5;
const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 9 };

/** GET handshake. Returns the challenge string to echo, or throws. */
export function verifyWebhookHandshake(q: { mode?: string | null; token?: string | null; challenge?: string | null }): string {
  const expected = env().WHATSAPP_VERIFY_TOKEN;
  if (q.mode === "subscribe" && expected && q.token === expected && q.challenge) return q.challenge;
  throw new AppError("FORBIDDEN", "Verification failed.");
}

/**
 * POST handler core. Verifies the signature over the RAW body, stores every event once (unique event key => duplicate
 * deliveries are no-ops), then processes pending events. Always cheap to acknowledge: failures are retried from the table.
 */
export async function receiveWhatsAppWebhook(rawBody: string, signature: string | null, clock: Clock = systemClock): Promise<{ accepted: number; duplicates: number }> {
  const secret = env().WHATSAPP_APP_SECRET;
  if (!secret || !verifySignature(rawBody, signature, secret)) {
    log("warn", "whatsapp.webhook.bad_signature");
    throw new AppError("FORBIDDEN", "Invalid signature.");
  }
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new AppError("VALIDATION", "Invalid JSON.");
  }
  const events = parseWebhook(json);
  const orgId = await getOrgId();
  let accepted = 0;
  let duplicates = 0;
  await withTx({ kind: "system", orgId, actor: "whatsapp" }, async (tx) => {
    for (const e of events) {
      const r = await tx.query(
        "insert into webhook_events(organisation_id, event_key, payload) values ($1,$2,$3) on conflict (provider, event_key) do nothing returning id",
        [orgId, e.key, JSON.stringify(e)]);
      if (r.length) accepted++;
      else duplicates++;
    }
  });
  if (accepted) await processWebhookEvents(orgId, clock).catch((err) => log("error", "whatsapp.webhook.process_failed", { error: (err as Error).message }));
  return { accepted, duplicates };
}

/** Process received/failed events (also called by the cron route to retry failures). */
export async function processWebhookEvents(orgId: string, clock: Clock = systemClock, limit = 50): Promise<number> {
  const pending = await withTx({ kind: "system", orgId, actor: "whatsapp" }, (tx) =>
    tx.query<{ id: string; payload: InboundEvent; attempts: number }>(
      `update webhook_events set attempts = attempts + 1
        where id in (select id from webhook_events where organisation_id = $1 and status in ('received','failed') and attempts < $2
                      order by received_at limit $3 for update skip locked)
        returning id, payload, attempts`, [orgId, MAX_ATTEMPTS, limit]));
  let done = 0;
  for (const ev of pending) {
    try {
      const actions = await withTx({ kind: "system", orgId, actor: "whatsapp" }, async (tx) => {
        const payload = { ...ev.payload, timestamp: new Date(ev.payload.timestamp) } as InboundEvent;
        const out = payload.kind === "status" ? (await applyStatus(tx, payload), null) : await applyMessage(orgId, tx, payload, clock);
        await tx.query("update webhook_events set status = 'processed', processed_at = now(), last_error = null, payload = $2 where id = $1", [ev.id, JSON.stringify(redact(payload))]);
        return out;
      });
      if (actions) await sendActions(orgId, actions.to, actions.actions);
      done++;
    } catch (err) {
      const dead = ev.attempts >= MAX_ATTEMPTS;
      log("error", "whatsapp.event.failed", { eventId: ev.id, attempt: ev.attempts, dead, error: (err as Error).message });
      await withTx({ kind: "system", orgId, actor: "whatsapp" }, (tx) =>
        tx.query("update webhook_events set status = $2, last_error = $3 where id = $1", [ev.id, dead ? "dead" : "failed", maskPhonesInText((err as Error).message).slice(0, 300)]));
    }
  }
  return done;
}

/** After processing, drop message text from the stored event: the conversation table holds what is needed. */
const redact = (e: InboundEvent): Record<string, unknown> =>
  e.kind === "message" ? { kind: e.kind, key: e.key, type: e.type, timestamp: e.timestamp } : { kind: e.kind, key: e.key, status: e.status, timestamp: e.timestamp };

async function applyStatus(tx: import("../db/tx").Tx, ev: Extract<InboundEvent, { kind: "status" }>): Promise<void> {
  const cur = await tx.maybeOne<{ status: string }>("select status from whatsapp_messages where provider_message_id = $1", [ev.waMessageId]);
  if (cur && (STATUS_RANK[ev.status] ?? 0) > (STATUS_RANK[cur.status] ?? 0)) {
    await tx.query("update whatsapp_messages set status = $2, error = $3 where provider_message_id = $1", [ev.waMessageId, ev.status, ev.errorText ?? null]);
  }
  if (ev.status === "failed") {
    await tx.query("update notification_jobs set last_error = $2 where provider_message_id = $1", [ev.waMessageId, (ev.errorText ?? "delivery failed").slice(0, 300)]);
  }
}

async function applyMessage(orgId: string, tx: import("../db/tx").Tx, ev: Extract<InboundEvent, { kind: "message" }>, clock: Clock): Promise<{ to: string; actions: Action[] }> {
  const phone = waIdToE164(ev.from);
  const contact = await tx.one<{ id: string }>(
    `insert into whatsapp_contacts(organisation_id, wa_id, profile_name, last_inbound_at, customer_id)
     values ($1,$2,$3,$4,(select id from customers where organisation_id = $1 and phone_e164 = $5 and anonymised_at is null))
     on conflict (organisation_id, wa_id) do update set last_inbound_at = greatest(whatsapp_contacts.last_inbound_at, excluded.last_inbound_at),
       profile_name = coalesce(excluded.profile_name, whatsapp_contacts.profile_name), updated_at = now()
     returning id`, [orgId, ev.from, ev.name ?? null, ev.timestamp, phone]);
  const conv = await tx.one<{ id: string; state: string; context: Record<string, unknown>; handoff_status: string }>(
    `insert into whatsapp_conversations(organisation_id, contact_id) values ($1,$2)
     on conflict (contact_id) do update set last_activity_at = now() returning id, state, context, handoff_status`, [orgId, contact.id]);
  const inserted = await tx.query(
    `insert into whatsapp_messages(organisation_id, conversation_id, contact_id, direction, provider_message_id, msg_type, body, occurred_at)
     values ($1,$2,$3,'inbound',$4,$5,$6,$7) on conflict do nothing returning id`,
    [orgId, conv.id, contact.id, ev.waMessageId, ev.type, (ev.text ?? "").slice(0, 1000) || null, ev.timestamp]);
  if (inserted.length === 0) return { to: phone, actions: [] }; // same WhatsApp message id seen before: never reply twice

  const res = await handleIncoming(orgId, tx, { id: conv.id, contactId: contact.id, state: conv.state, context: conv.context, handoff: conv.handoff_status }, ev, phone, clock);
  await tx.query(
    `update whatsapp_conversations set state = $2, context = $3, handoff_status = coalesce($4, handoff_status),
            handoff_requested_at = case when $4 = 'requested' then now() else handoff_requested_at end where id = $1`,
    [conv.id, res.state, JSON.stringify(res.context), res.handoff ?? null]);
  return { to: phone, actions: res.actions };
}

async function sendActions(orgId: string, to: string, actions: Action[]): Promise<void> {
  const p = getProvider();
  for (const a of actions) {
    const r = a.type === "text" ? await p.sendText(to, a.body) : a.type === "buttons" ? await p.sendButtons(to, a.body, a.buttons) : await p.sendList(to, a.body, a.label, a.rows);
    if (!r.ok) {
      // The customer can simply message again; record and move on rather than retrying a stale prompt.
      log("warn", "whatsapp.reply.failed", { retryable: r.retryable, error: r.error });
      continue;
    }
    await withTx({ kind: "system", orgId, actor: "whatsapp" }, (tx) =>
      tx.query(
        `insert into whatsapp_messages(organisation_id, contact_id, conversation_id, direction, provider_message_id, msg_type, body, status)
         select $1, c.id, v.id, 'outbound', $3, $4, $5, 'sent' from whatsapp_contacts c left join whatsapp_conversations v on v.contact_id = c.id
          where c.organisation_id = $1 and c.wa_id = $2 on conflict do nothing`,
        [orgId, to.replace(/\D/g, ""), r.messageId, a.type, a.body.slice(0, 1000)]));
  }
}
