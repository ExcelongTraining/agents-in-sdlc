import { DateTime } from "luxon";
import type { Tx } from "../db/tx";
import { env } from "../config/env";
import { AppError, isAppError } from "../errors";
import { e164ToWaId, waIdToE164 } from "../domain/phone";
import { formatLocal, startOfLocalDay } from "../domain/time";
import type { ButtonOption, ListRow } from "../whatsapp/provider";
import { confirmHold, createHold, joinWaitlist, releaseHold } from "./booking";
import { manageToken, recordConsents, systemClock, type Clock } from "./booking-shared";
import { searchSlots, qualifiedStaff } from "./availability";
import { notifyManagers } from "./notifications";
import { loadSettings } from "./settings";
import type { InboundEvent } from "../whatsapp/inbound";

export type Action =
  | { type: "text"; body: string }
  | { type: "buttons"; body: string; buttons: ButtonOption[] }
  | { type: "list"; body: string; label: string; rows: ListRow[] };

type Message = Extract<InboundEvent, { kind: "message" }>;

interface Ctx {
  consented?: boolean;
  name?: string;
  serviceId?: string;
  staffId?: string; // uuid or "any"
  date?: string;
  startAt?: string;
  holdToken?: string;
  holdMinutes?: number;
}
interface Conv {
  id: string;
  contactId: string;
  state: string;
  context: Ctx;
  handoff: string;
}

export const NOTICE_VERSION = "2026-01";
const STOP_WORDS = new Set(["stop", "unsubscribe", "berhenti", "cancel subscription"]);
const HUMAN_WORDS = new Set(["human", "agent", "person", "manager", "staff", "orang", "talk to a person"]);

const menu = (): Action => ({
  type: "buttons",
  body: "Hi! How can we help?",
  buttons: [
    { id: "m:book", title: "Book a session" },
    { id: "m:mine", title: "My booking" },
    { id: "m:human", title: "Talk to a person" },
  ],
});

/**
 * One step of the booking conversation. Returns the replies to send AFTER the transaction commits.
 * All availability decisions go through the same engine as the website; this module holds no schedule of its own.
 */
export async function handleIncoming(
  orgId: string,
  tx: Tx,
  conv: Conv,
  ev: Message,
  phoneE164: string,
  clock: Clock = systemClock,
): Promise<{ actions: Action[]; state: string; context: Ctx; handoff?: string }> {
  let input = (ev.replyId ?? ev.text ?? "").trim();
  const lower = input.toLowerCase();
  if (lower === "book" || lower === "start") input = "m:book";
  let ctx: Ctx = { ...conv.context };
  const out = (state: string, actions: Action[], c: Ctx = ctx, handoff?: string) => ({
    actions,
    state,
    context: c,
    handoff,
  });

  // --- Global commands ---------------------------------------------------------------------------------------------
  if (STOP_WORDS.has(lower)) {
    await tx.query("update whatsapp_contacts set opted_out_at = now() where id = $1", [conv.contactId]);
    const cust = await customerFor(tx, phoneE164);
    if (cust)
      await recordConsents(
        tx,
        cust.id,
        { serviceBooking: true, whatsapp: false, marketing: false },
        NOTICE_VERSION,
        "whatsapp",
      );
    return out(
      "idle",
      [
        {
          type: "text",
          body: "You have been unsubscribed and will not receive further messages. Send BOOK any time to start again.",
        },
      ],
      {},
    );
  }
  if (lower === "book" || lower === "start") {
    await tx.query("update whatsapp_contacts set opted_out_at = null where id = $1", [conv.contactId]);
  }
  if (conv.handoff === "requested" || conv.handoff === "human") {
    if (lower === "menu" || lower === "bot") return out("idle", [menu()], {}, "bot");
    return out(conv.state, [], ctx); // a person is handling this chat: stay quiet
  }
  if (HUMAN_WORDS.has(lower) || input === "m:human") {
    const cust = await customerFor(tx, phoneE164);
    await notifyManagers(
      tx,
      "human_handoff",
      { customer: cust?.display_name.split(" ")[0] ?? "a customer" },
      null,
      `handoff:${conv.id}:${ev.waMessageId}`,
    );
    return out(
      "handoff",
      [
        {
          type: "text",
          body: "No problem, a team member will reply here soon. Send MENU to go back to the automated assistant.",
        },
      ],
      ctx,
      "requested",
    );
  }
  if (lower === "menu" || lower === "hi" || lower === "hello" || lower === "hai" || conv.state === "idle") {
    if (input !== "m:book" && input !== "m:mine") return out("idle", [menu()], {});
  }

  const settings = await loadSettings(tx);
  const branch = await tx.one<{ id: string; timezone: string }>(
    "select id, timezone from branches where organisation_id = $1 and active order by created_at limit 1",
    [orgId],
  );
  const tz = branch.timezone;
  const customer = await customerFor(tx, phoneE164);
  const now = clock.now();
  let state = conv.state;

  // --- Entry points ------------------------------------------------------------------------------------------------
  if (input === "m:mine") {
    const next =
      customer &&
      (await tx.maybeOne<{ id: string; start_at: Date; name: string }>(
        `select a.id, a.start_at, s.name from appointments a join services s on s.id = a.service_id
        where a.customer_id = $1 and a.status in ('confirmed','pending_confirmation') and a.start_at > $2 order by a.start_at limit 1`,
        [customer.id, now],
      ));
    if (!next)
      return out(
        "idle",
        [{ type: "text", body: "You have no upcoming bookings. Send BOOK to make one." }],
        {},
      );
    return out(
      "idle",
      [
        {
          type: "text",
          body: `Your next booking: ${next.name}, ${formatLocal(next.start_at, tz)}.\nManage it here: ${env().APP_BASE_URL}/manage/${manageToken(next.id)}`,
        },
      ],
      {},
    );
  }
  if (input === "m:book") {
    ctx = { name: customer?.display_name };
    state = customer ? "service" : "consent";
    if (customer && !(await hasServiceConsent(tx, customer.id))) state = "consent";
  }

  // --- Step transitions --------------------------------------------------------------------------------------------
  if (state === "consent" && input === "c:no")
    return out(
      "idle",
      [
        {
          type: "text",
          body: "That's fine. We can't take a booking without your consent. You can also call us. Send BOOK to start again.",
        },
      ],
      {},
    );
  if (state === "consent" && input === "c:yes") {
    ctx.consented = true;
    state = ctx.name ? "service" : "name";
  } else if (state === "name" && ev.type === "text" && input.length >= 2 && input.length <= 100) {
    ctx.name = input;
    state = "service";
  } else if (state === "service" && input.startsWith("s:")) {
    ctx.serviceId = input.slice(2);
    state = "staff";
  } else if (state === "staff" && input.startsWith("p:")) {
    ctx.staffId = input.slice(2);
    state = "date";
  } else if (state === "date" && input.startsWith("d:")) {
    ctx.date = input.slice(2);
    state = "time";
  } else if (state === "date" && input === "w:join" && ctx.serviceId) {
    const from = new Date(now.getTime() + settings.booking.minNoticeMinutes * 60_000);
    await joinWaitlist(orgId, {
      branchId: branch.id,
      serviceId: ctx.serviceId,
      preferredStaffId: ctx.staffId && ctx.staffId !== "any" ? ctx.staffId : undefined,
      windowStart: from,
      windowEnd: new Date(from.getTime() + 14 * 86400_000),
      customer: { name: ctx.name ?? "Customer", phone: phoneE164 },
      consent: { serviceBooking: true, whatsapp: true },
      noticeVersion: NOTICE_VERSION,
    });
    return out(
      "idle",
      [{ type: "text", body: "You're on the wait-list. We'll message you if a time opens up." }],
      {},
    );
  } else if (state === "date" && input === "p:any") {
    ctx.staffId = "any";
  } else if (state === "time" && input.startsWith("t:")) {
    ctx.startAt = input.slice(2);
    try {
      const hold = await createHold(
        orgId,
        {
          branchId: branch.id,
          serviceId: ctx.serviceId as string,
          startAt: new Date(ctx.startAt),
          staffId: (ctx.staffId ?? "any") as string,
          source: "whatsapp",
          idempotencyKey: `wa-${ev.waMessageId}-hold`.slice(0, 120),
        },
        clock,
      );
      ctx.holdToken = hold.holdToken;
      ctx.holdMinutes = settings.booking.holdMinutes;
      return out(
        "confirm",
        [
          {
            type: "buttons",
            body: `Please confirm: ${hold.serviceName} with ${hold.staffName} on ${formatLocal(new Date(hold.startAt), tz)}. We'll hold it for ${settings.booking.holdMinutes} minutes.`,
            buttons: [
              { id: "y:confirm", title: "Confirm" },
              { id: "y:cancel", title: "Cancel" },
            ],
          },
        ],
        ctx,
      );
    } catch (e) {
      if (isAppError(e) && ["SLOT_TAKEN", "STAFF_UNAVAILABLE", "ROOM_TAKEN"].includes(e.code)) {
        return out(
          "time",
          [
            { type: "text", body: "Sorry, that time was just taken. Please choose another." },
            ...(await timeStep(tx, ctx, branch.id, tz, now)),
          ],
          ctx,
        );
      }
      throw e;
    }
  } else if (state === "confirm" && input === "y:confirm" && ctx.holdToken) {
    try {
      const booked = await confirmHold(
        orgId,
        {
          holdToken: ctx.holdToken,
          customer: { name: ctx.name ?? customer?.display_name ?? "Customer", phone: phoneE164 },
          consent: { serviceBooking: true, whatsapp: true, marketing: false },
          noticeVersion: NOTICE_VERSION,
          idempotencyKey: `wa-${ev.waMessageId}-confirm`.slice(0, 120),
        },
        clock,
      );
      await tx.query(
        "update whatsapp_contacts set customer_id = (select id from customers where phone_e164 = $2 and organisation_id = $3 and anonymised_at is null), opted_in_at = coalesce(opted_in_at, now()) where id = $1",
        [conv.contactId, phoneE164, orgId],
      );
      return out(
        "idle",
        [
          {
            type: "text",
            body: `Booked! ${booked.serviceName} with ${booked.staffName}, ${formatLocal(new Date(booked.startAt), tz)}. A confirmation will follow.`,
          },
        ],
        {},
      );
    } catch (e) {
      if (isAppError(e) && e.code === "HOLD_EXPIRED")
        return out(
          "idle",
          [{ type: "text", body: "That reservation expired. Send BOOK to choose a time again." }],
          {},
        );
      throw e;
    }
  } else if (state === "confirm" && input === "y:cancel") {
    if (ctx.holdToken) await releaseHold(orgId, ctx.holdToken);
    return out("idle", [{ type: "text", body: "Okay, I've released that time. Send BOOK any time." }], {});
  }

  // --- Prompt for the (new) state ----------------------------------------------------------------------------------
  switch (state) {
    case "consent":
      return out(
        "consent",
        [
          {
            type: "buttons",
            body: `To book we need to store your name, phone number and booking details to run your appointment, and message you on WhatsApp about it. See our privacy notice: ${env().APP_BASE_URL}/privacy. Do you agree?`,
            buttons: [
              { id: "c:yes", title: "I agree" },
              { id: "c:no", title: "No thanks" },
            ],
          },
        ],
        ctx,
      );
    case "name":
      return out("name", [{ type: "text", body: "What name should we put the booking under?" }], ctx);
    case "service": {
      const rows = (
        await tx.query<{ id: string; name: string; duration_minutes: number }>(
          "select id, name, duration_minutes from services where organisation_id = $1 and active and online_bookable order by kind desc, name limit 10",
          [orgId],
        )
      ).map((s) => ({
        id: `s:${s.id}`,
        title: s.name.slice(0, 24),
        description: `${s.duration_minutes} min`,
      }));
      return out(
        "service",
        [
          {
            type: "list",
            body: "What would you like to book? Choose a consultation if you'd like to talk first.",
            label: "Choose",
            rows,
          },
        ],
        ctx,
      );
    }
    case "staff": {
      const staff = await qualifiedStaff(tx, branch.id, ctx.serviceId as string);
      const rows: ListRow[] = [
        { id: "p:any", title: "Any available" },
        ...staff.slice(0, 9).map((s) => ({ id: `p:${s.id}`, title: s.display_name.slice(0, 24) })),
      ];
      return out(
        "staff",
        [{ type: "list", body: "Do you have a preferred masseuse?", label: "Choose", rows }],
        ctx,
      );
    }
    case "date": {
      const from = DateTime.fromJSDate(now, { zone: tz }).toISODate() as string;
      const to = DateTime.fromJSDate(now, { zone: tz }).plus({ days: 14 }).toISODate() as string;
      const { slots } = await searchSlots(tx, {
        branchId: branch.id,
        serviceId: ctx.serviceId as string,
        fromDate: from,
        toDate: to,
        staffId: ctx.staffId && ctx.staffId !== "any" ? ctx.staffId : undefined,
        now,
        enforceNotice: true,
        publicOnly: true,
      });
      const dates = [
        ...new Set(slots.map((s) => DateTime.fromJSDate(s.startAt, { zone: tz }).toISODate() as string)),
      ].slice(0, 10);
      if (dates.length === 0) {
        const buttons: ButtonOption[] = [{ id: "w:join", title: "Join wait-list" }];
        if (ctx.staffId !== "any") buttons.unshift({ id: "p:any", title: "Any masseuse" });
        return out(
          "date",
          [{ type: "buttons", body: "No times are free in the next two weeks for that choice.", buttons }],
          ctx,
        );
      }
      return out(
        "date",
        [
          {
            type: "list",
            body: "Which day suits you?",
            label: "Choose day",
            rows: dates.map((d) => ({
              id: `d:${d}`,
              title: DateTime.fromISO(d, { zone: tz }).toFormat("EEE d MMM"),
            })),
          },
        ],
        ctx,
      );
    }
    case "time":
      return out("time", await timeStep(tx, ctx, branch.id, tz, now), ctx);
    case "confirm":
      return out(
        "confirm",
        [
          {
            type: "buttons",
            body: "Please confirm or cancel your pending booking.",
            buttons: [
              { id: "y:confirm", title: "Confirm" },
              { id: "y:cancel", title: "Cancel" },
            ],
          },
        ],
        ctx,
      );
    default:
      return out("idle", [menu()], {});
  }
}

async function timeStep(tx: Tx, ctx: Ctx, branchId: string, tz: string, now: Date): Promise<Action[]> {
  const date = ctx.date as string;
  const { grouped } = await searchSlots(tx, {
    branchId,
    serviceId: ctx.serviceId as string,
    fromDate: date,
    toDate: date,
    staffId: ctx.staffId && ctx.staffId !== "any" ? ctx.staffId : undefined,
    now,
    enforceNotice: true,
    publicOnly: true,
  });
  if (grouped.length === 0)
    return [{ type: "text", body: "No times left that day. Send BOOK to start again." }];
  // Spread the 10 rows across the day rather than listing only the morning.
  const step = Math.max(1, Math.ceil(grouped.length / 10));
  const picks = grouped.filter((_, i) => i % step === 0).slice(0, 10);
  return [
    {
      type: "list",
      body: "Choose a time:",
      label: "Choose time",
      rows: picks.map((g) => ({
        id: `t:${g.startAt.toISOString()}`,
        title: formatLocal(g.startAt, tz, "h:mm a"),
      })),
    },
  ];
}

async function customerFor(tx: Tx, phoneE164: string): Promise<{ id: string; display_name: string } | null> {
  return tx.maybeOne(
    "select id, display_name from customers where organisation_id = $1 and phone_e164 = $2 and anonymised_at is null",
    [tx.ctx.orgId, phoneE164],
  );
}
async function hasServiceConsent(tx: Tx, customerId: string): Promise<boolean> {
  const r = await tx.maybeOne<{ granted: boolean }>(
    "select granted from customer_consents where customer_id = $1 and purpose = 'service_booking' order by recorded_at desc limit 1",
    [customerId],
  );
  return !!r?.granted;
}
export { waIdToE164, e164ToWaId, startOfLocalDay, AppError };
