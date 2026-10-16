import { withTx, type Tx } from "../db/tx";
import { e164ToWaId } from "../domain/phone";
import { log } from "../log";
import { getProvider } from "../whatsapp/provider";
import { renderNotification } from "../whatsapp/messages";
import type { NotificationPurpose } from "./notifications";
import { loadSettings } from "./settings";
import { systemClock, type Clock } from "./booking-shared";

interface JobRow {
  id: string;
  purpose: NotificationPurpose;
  recipient_kind: "customer" | "staff" | "user";
  recipient_id: string;
  params: Record<string, string | number>;
  appointment_id: string | null;
  attempts: number;
  max_attempts: number;
}

export interface OutboxResult {
  sent: number;
  retried: number;
  dead: number;
  skipped: number;
}

/** Exponential backoff with jitter: 30s, 1m, 2m, 4m ... capped at 1h. */
export const backoffSeconds = (attempt: number, jitter = Math.random()): number =>
  Math.min(3600, 30 * 2 ** Math.max(attempt - 1, 0)) * (0.85 + 0.3 * jitter);

type Recipient = { phone: string; waId: string } | { skip: string };

async function resolveRecipient(tx: Tx, job: JobRow): Promise<Recipient> {
  if (job.recipient_kind === "customer") {
    const c = await tx.maybeOne<{ phone_e164: string; anonymised_at: Date | null }>(
      "select phone_e164, anonymised_at from customers where id = $1",
      [job.recipient_id],
    );
    if (!c || c.anonymised_at) return { skip: "customer unavailable" };
    // Verification codes are requested by the customer themselves; everything else needs consent and no opt-out.
    if (job.purpose !== "customer_otp") {
      const consent = await tx.maybeOne<{ granted: boolean }>(
        "select granted from customer_consents where customer_id = $1 and purpose = 'whatsapp_messaging' order by recorded_at desc limit 1",
        [job.recipient_id],
      );
      if (!consent?.granted) return { skip: "no WhatsApp consent" };
      const opted = await tx.maybeOne<{ o: Date | null }>(
        "select opted_out_at o from whatsapp_contacts where wa_id = $1 and organisation_id = $2",
        [e164ToWaId(c.phone_e164), tx.ctx.orgId],
      );
      if (opted?.o) return { skip: "customer opted out" };
    }
    return { phone: c.phone_e164, waId: e164ToWaId(c.phone_e164) };
  }
  const table = job.recipient_kind === "staff" ? "staff_profiles" : "users";
  const r = await tx.maybeOne<{ phone_e164: string | null }>(
    `select phone_e164 from ${table} where id = $1`,
    [job.recipient_id],
  );
  if (!r?.phone_e164) return { skip: "recipient has no phone number" };
  return { phone: r.phone_e164, waId: e164ToWaId(r.phone_e164) };
}

/** Is the notification still relevant at send time? (Reminder for a cancelled booking must not go out.) */
async function stillRelevant(tx: Tx, job: JobRow): Promise<boolean> {
  if (!job.appointment_id) return true;
  const a = await tx.maybeOne<{ status: string }>("select status from appointments where id = $1", [
    job.appointment_id,
  ]);
  if (!a) return false;
  if (job.purpose === "appointment_reminder") return a.status === "confirmed";
  if (job.purpose === "booking_confirmed")
    return [
      "confirmed",
      "checked_in",
      "in_progress",
      "completed",
      "replacement_pending",
      "pending_confirmation",
    ].includes(a.status);
  return true;
}

/**
 * Deliver due notification jobs. Safe to run concurrently (rows are claimed with SKIP LOCKED + a lease). Each failure
 * schedules a retry with exponential backoff; permanent failures and exhausted retries go to status 'dead' (dead-letter).
 */
export async function processDueNotifications(
  orgId: string,
  opts: { limit?: number; clock?: Clock } = {},
): Promise<OutboxResult> {
  const clock = opts.clock ?? systemClock;
  const now = clock.now();
  const result: OutboxResult = { sent: 0, retried: 0, dead: 0, skipped: 0 };
  const jobs = await withTx({ kind: "system", orgId, actor: "job" }, (tx) =>
    tx.query<JobRow>(
      `update notification_jobs set status = 'processing', locked_until = $2::timestamptz + interval '2 minutes', attempts = attempts + 1
        where id in (select id from notification_jobs where organisation_id = $1 and status in ('pending','failed','processing')
                        and next_attempt_at <= $2 and (locked_until is null or locked_until < $2) order by next_attempt_at limit $3 for update skip locked)
        returning id, purpose, recipient_kind, recipient_id, params, appointment_id, attempts, max_attempts`,
      [orgId, now, opts.limit ?? 25],
    ),
  );

  for (const job of jobs) {
    const outcome = await deliver(orgId, job, now);
    result[outcome]++;
  }
  return result;
}

async function deliver(orgId: string, job: JobRow, now: Date): Promise<keyof OutboxResult> {
  const provider = getProvider();
  const prepared = await withTx({ kind: "system", orgId, actor: "job" }, async (tx) => {
    if (!(await stillRelevant(tx, job))) return { skip: "no longer relevant" } as const;
    const rcpt = await resolveRecipient(tx, job);
    if ("skip" in rcpt) return rcpt;
    const settings = await loadSettings(tx);
    const tpl = await tx.maybeOne<{ name: string; language: string; param_names: string[]; status: string }>(
      "select name, language, param_names, status from whatsapp_templates where purpose = $1 and language = $2",
      [job.purpose, settings.whatsapp.language],
    );
    const contact = await tx.maybeOne<{ last_inbound_at: Date | null }>(
      "select last_inbound_at from whatsapp_contacts where wa_id = $1 and organisation_id = $2",
      [rcpt.waId, orgId],
    );
    const inWindow =
      !!contact?.last_inbound_at &&
      now.getTime() - contact.last_inbound_at.getTime() < settings.whatsapp.windowHours * 3600_000;
    return { rcpt, tpl, inWindow } as const;
  });

  if ("skip" in prepared) {
    await finish(orgId, job.id, { status: "skipped", error: prepared.skip });
    return "skipped";
  }
  const { rcpt, tpl, inWindow } = prepared;
  let res;
  if (tpl && tpl.status === "approved") {
    res = await provider.sendTemplate(
      rcpt.phone,
      tpl.name,
      tpl.language,
      tpl.param_names.map((n) => String(job.params[n] ?? "")),
    );
  } else if (inWindow) {
    res = await provider.sendText(rcpt.phone, renderNotification(job.purpose, job.params));
  } else {
    res = {
      ok: false as const,
      retryable: false,
      error: "No approved template and the 24-hour service window is closed",
    };
  }

  if (res.ok) {
    await finish(orgId, job.id, {
      status: "sent",
      messageId: res.messageId,
      outbound: { waId: rcpt.waId, purpose: job.purpose },
    });
    return "sent";
  }
  const exhausted = job.attempts >= job.max_attempts;
  log("warn", "notification.failed", {
    jobId: job.id,
    purpose: job.purpose,
    attempt: job.attempts,
    retryable: res.retryable,
    error: res.error,
  });
  if (!res.retryable || exhausted) {
    await finish(orgId, job.id, { status: "dead", error: res.error });
    return "dead";
  }
  await finish(orgId, job.id, {
    status: "failed",
    error: res.error,
    retryAt: new Date(now.getTime() + backoffSeconds(job.attempts) * 1000),
  });
  return "retried";
}

async function finish(
  orgId: string,
  id: string,
  o: {
    status: "sent" | "failed" | "dead" | "skipped";
    error?: string;
    messageId?: string;
    retryAt?: Date;
    outbound?: { waId: string; purpose: string };
  },
): Promise<void> {
  await withTx({ kind: "system", orgId, actor: "job" }, async (tx) => {
    await tx.query(
      `update notification_jobs set status = $2, last_error = $3, provider_message_id = $4, locked_until = null,
              next_attempt_at = coalesce($5, next_attempt_at), sent_at = case when $2 = 'sent' then now() else sent_at end,
              params = case when $2 in ('sent','dead','skipped') then '{}'::jsonb else params end
        where id = $1`,
      [id, o.status, o.error ?? null, o.messageId ?? null, o.retryAt ?? null],
    );
    if (o.outbound && o.messageId) {
      // Templates carry no stored body: we keep the purpose and provider id for status tracking only.
      await tx.query(
        `insert into whatsapp_messages(organisation_id, contact_id, direction, provider_message_id, msg_type, template_purpose, status)
         values ($1, (select id from whatsapp_contacts where wa_id = $2 and organisation_id = $1), 'outbound', $3, 'template', $4, 'sent')
         on conflict do nothing`,
        [orgId, o.outbound.waId, o.messageId, o.outbound.purpose],
      );
    }
  });
}
