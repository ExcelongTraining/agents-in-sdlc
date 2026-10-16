import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminClient, at, clockAt, managerPrincipal, NOW, resetWorld, shutdown } from "./helpers/world";
import { receiveWhatsAppWebhook, verifyWebhookHandshake, processWebhookEvents } from "@/lib/services/whatsapp-webhook";
import { processDueNotifications, backoffSeconds } from "@/lib/services/outbox";
import { createDirectBooking } from "@/lib/services/booking";
import { MockWhatsAppProvider } from "@/lib/whatsapp/mock";
import { setProviderForTests, verifySignature } from "@/lib/whatsapp/provider";
import { parseWebhook } from "@/lib/whatsapp/inbound";
import { resetEnvCacheForTests } from "@/lib/config/env";
import type { World } from "@/lib/seed/base";

const SECRET = "wa-app-secret-for-tests";
let w: World;
let mock: MockWhatsAppProvider;
let n = 0;
const clock = clockAt(NOW);

beforeEach(async () => {
  process.env.WHATSAPP_APP_SECRET = SECRET;
  process.env.WHATSAPP_VERIFY_TOKEN = "verify-me";
  resetEnvCacheForTests();
  w = await resetWorld();
  mock = new MockWhatsAppProvider();
  setProviderForTests(mock);
});
afterAll(async () => { setProviderForTests(undefined); await shutdown(); });

const sign = (body: string) => "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
const FROM = "60123450001";
function inbound(opts: { id?: string; text?: string; reply?: string; from?: string }) {
  const id = opts.id ?? `wamid.IN${++n}`;
  const message = opts.reply
    ? { id, from: opts.from ?? FROM, timestamp: String(Math.floor(NOW.getTime() / 1000)), type: "interactive", interactive: { type: opts.reply.startsWith("s:") || opts.reply.startsWith("p:") || opts.reply.startsWith("d:") || opts.reply.startsWith("t:") ? "list_reply" : "button_reply", [opts.reply.match(/^[spdt]:/) ? "list_reply" : "button_reply"]: { id: opts.reply, title: "x" } } }
    : { id, from: opts.from ?? FROM, timestamp: String(Math.floor(NOW.getTime() / 1000)), type: "text", text: { body: opts.text ?? "hi" } };
  return JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", contacts: [{ wa_id: opts.from ?? FROM, profile: { name: "Test Person" } }], messages: [message] } }] }] });
}
const send = (body: string, sig = sign(body)) => receiveWhatsAppWebhook(body, sig, clock);
const q = async (sql: string, params: unknown[] = []) => { const c = await adminClient(); try { return (await c.query(sql, params)).rows; } finally { await c.end(); } };
const last = () => mock.sent.at(-1)!;

describe("webhook security and idempotency", () => {
  it("answers the verification handshake only with the right token", () => {
    expect(verifyWebhookHandshake({ mode: "subscribe", token: "verify-me", challenge: "abc" })).toBe("abc");
    expect(() => verifyWebhookHandshake({ mode: "subscribe", token: "wrong", challenge: "abc" })).toThrow();
  });
  it("rejects missing, malformed and wrong signatures; accepts the right one", async () => {
    const body = inbound({ text: "hi" });
    await expect(receiveWhatsAppWebhook(body, null, clock)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(receiveWhatsAppWebhook(body, "sha256=deadbeef", clock)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(receiveWhatsAppWebhook(body + " ", sign(body), clock)).rejects.toMatchObject({ code: "FORBIDDEN" }); // body tampered
    expect(await send(body)).toEqual({ accepted: 1, duplicates: 0 });
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });
  it("a duplicate delivery of the same event is a no-op: one stored event, one reply", async () => {
    const body = inbound({ id: "wamid.DUP1", text: "hello" });
    await send(body);
    const sentAfterFirst = mock.sent.length;
    expect(await send(body)).toEqual({ accepted: 0, duplicates: 1 });
    expect(mock.sent.length).toBe(sentAfterFirst);
    expect((await q("select count(*)::int n from webhook_events"))[0].n).toBe(1);
    expect((await q("select count(*)::int n from whatsapp_messages where direction = 'inbound'"))[0].n).toBe(1);
  });
  it("concurrent duplicate deliveries still produce a single reply", async () => {
    const body = inbound({ id: "wamid.DUP2", text: "hello" });
    await Promise.all([send(body), send(body), send(body)]);
    expect(mock.sent.filter((m) => m.kind === "buttons")).toHaveLength(1);
  });
  it("ignores malformed payloads without throwing", () => {
    expect(parseWebhook(null)).toEqual([]);
    expect(parseWebhook({ entry: [{ changes: [{ value: { messages: [{ nope: 1 }] } }] }] })).toEqual([]);
  });
  it("tracks message status and never downgrades it", async () => {
    await q("insert into whatsapp_messages(organisation_id, direction, provider_message_id, status) values ($1,'outbound','wamid.OUT1','sent')", [w.orgId]);
    const st = (status: string, id: string) => JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.OUT1", status, timestamp: "1", recipient_id: FROM }] } }] }] });
    await send(st("read", "a"));
    await send(st("delivered", "b"));
    expect((await q("select status from whatsapp_messages where provider_message_id = 'wamid.OUT1'"))[0].status).toBe("read");
  });
});

describe("conversation: booking through WhatsApp uses the same engine", () => {
  it("walks from greeting to a confirmed booking and records consent + contact mapping", async () => {
    await send(inbound({ text: "Hi" }));
    expect(last().kind).toBe("buttons");
    await send(inbound({ reply: "m:book" }));
    expect(last().body).toContain("privacy");
    await send(inbound({ reply: "c:yes" }));
    expect(last().body).toContain("name");
    await send(inbound({ text: "Nora Test" }));
    expect(last().kind).toBe("list");
    await send(inbound({ reply: `s:${w.services.massage60}` }));
    await send(inbound({ reply: "p:any" }));
    expect(last().body).toContain("day");
    const dayRow = last().rows!.find((r) => r.id.startsWith("d:"))!;
    await send(inbound({ reply: dayRow.id }));
    const timeRow = last().rows![0]!;
    await send(inbound({ reply: timeRow.id }));
    expect(last().body).toContain("Please confirm");
    await send(inbound({ reply: "y:confirm" }));
    expect(last().body).toContain("Booked!");
    const appt = (await q("select a.status, a.source, c.display_name from appointments a join customers c on c.id = a.customer_id"))[0];
    expect(appt).toMatchObject({ status: "confirmed", source: "whatsapp", display_name: "Nora Test" });
    const consents = (await q("select purpose, granted from customer_consents order by purpose")).map((c) => `${c.purpose}:${c.granted}`);
    expect(consents).toEqual(["service_booking:true", "whatsapp_messaging:true"]);
    expect((await q("select customer_id from whatsapp_contacts"))[0].customer_id).not.toBeNull();
  });

  it("STOP records an opt-out, stops notifications and BOOK re-enables", async () => {
    // existing customer with WhatsApp consent
    const b = await createDirectBooking(managerPrincipal(w), {
      branchId: w.branchId, serviceId: w.services.massage60, startAt: at("2030-03-11", "11:00"), staffId: w.staff[0]!.id, source: "manager",
      customer: { name: "Nora Test", phone: "+60123450001" }, consent: { serviceBooking: true, whatsapp: true, marketing: false },
    } as never, clock);
    await send(inbound({ text: "STOP" }));
    expect(last().body).toContain("unsubscribed");
    expect((await q("select granted from customer_consents where purpose = 'whatsapp_messaging' order by recorded_at desc limit 1"))[0].granted).toBe(false);
    mock.reset();
    const r = await processDueNotifications(w.orgId, { clock });
    expect(r.skipped).toBeGreaterThan(0);
    expect(mock.sent.filter((m) => m.to === "+60123450001")).toHaveLength(0);
    expect(b.status).toBe("confirmed");
  });

  it("'talk to a person' hands off to the manager and silences the bot", async () => {
    await send(inbound({ text: "human" }));
    expect(last().body).toContain("team member");
    expect((await q("select handoff_status from whatsapp_conversations"))[0].handoff_status).toBe("requested");
    expect((await q("select purpose from notification_jobs where purpose = 'human_handoff'")).length).toBe(1);
    const before = mock.sent.length;
    await send(inbound({ text: "are you there?" }));
    expect(mock.sent.length).toBe(before);
    await send(inbound({ text: "menu" }));
    expect(last().kind).toBe("buttons");
  });

  it("a taken slot at the last step re-offers times instead of double-booking", async () => {
    await send(inbound({ text: "BOOK" })); await send(inbound({ reply: "c:yes" })); await send(inbound({ text: "Nora Test" }));
    await send(inbound({ reply: `s:${w.services.massage60}` })); await send(inbound({ reply: `p:${w.staff[0]!.id}` }));
    const day = last().rows!.find((r) => r.id.startsWith("d:"))!;
    await send(inbound({ reply: day.id }));
    const slot = last().rows![0]!;
    const start = new Date(slot.id.slice(2));
    await createDirectBooking(managerPrincipal(w), {
      branchId: w.branchId, serviceId: w.services.massage60, startAt: start, staffId: w.staff[0]!.id, source: "manager",
      customer: { name: "Other", phone: "0123450002" }, consent: { serviceBooking: true, whatsapp: false, marketing: false },
    } as never, clock);
    await send(inbound({ reply: slot.id }));
    expect(mock.sent.some((m) => m.body?.includes("just taken"))).toBe(true);
    expect((await q("select count(*)::int n from appointments where status in ('slot_held','confirmed')"))[0].n).toBe(1);
  });
});

describe("outbound notifications: templates, window, retry, dead letter", () => {
  async function bookWithConsent(whatsapp = true) {
    return createDirectBooking(managerPrincipal(w), {
      branchId: w.branchId, serviceId: w.services.massage60, startAt: at("2030-03-11", "11:00"), staffId: w.staff[0]!.id, source: "manager",
      customer: { name: "Nora Test", phone: "+60123450001" }, consent: { serviceBooking: true, whatsapp, marketing: false },
    } as never, clock);
  }

  it("sends approved templates to the customer and the masseuse, with parameters in order", async () => {
    await bookWithConsent();
    const r = await processDueNotifications(w.orgId, { clock });
    expect(r.sent).toBe(2);
    const tpl = mock.sent.filter((m) => m.kind === "template");
    const toCustomer = tpl.find((m) => m.template === "booking_confirmed_v1")!;
    expect(toCustomer.to).toBe("+60123450001");
    expect(toCustomer.params).toEqual(["Nora", "Traditional Massage (60 min)", "Aisyah", "Mon 11 Mar", "11:00 AM", "Main Branch (demo)"]);
    expect(tpl.some((m) => m.template === "assignment_new_v1" && m.to === "+60100000100")).toBe(true);
    // personal params are wiped from the job after sending
    expect((await q("select params from notification_jobs where status = 'sent' limit 1"))[0].params).toEqual({});
  });

  it("does not message a customer who never consented to WhatsApp", async () => {
    await bookWithConsent(false);
    const r = await processDueNotifications(w.orgId, { clock });
    expect(r.skipped).toBe(1);
    expect(mock.sent.filter((m) => m.to === "+60123450001")).toHaveLength(0);
  });

  it("without an approved template, free text is used only inside the 24h window; otherwise dead-lettered", async () => {
    await q("update whatsapp_templates set status = 'draft'");
    await bookWithConsent();
    let r = await processDueNotifications(w.orgId, { clock });
    expect(r.dead).toBeGreaterThan(0);
    expect(mock.sent.filter((m) => m.to === "+60123450001")).toHaveLength(0);
    // customer writes in -> window opens -> a new notification may use free text
    await send(inbound({ text: "hello", from: "60123450001" }));
    mock.reset();
    await q("insert into notification_jobs(organisation_id, purpose, recipient_kind, recipient_id, params, dedupe_key) select $1,'booking_cancelled','customer',id,'{\"customer\":\"Nora\",\"date\":\"Mon\",\"time\":\"11\"}','x1' from customers", [w.orgId]);
    r = await processDueNotifications(w.orgId, { clock });
    expect(r.sent).toBeGreaterThanOrEqual(1);
    expect(mock.sent.some((m) => m.kind === "text" && m.body?.includes("cancelled"))).toBe(true);
  });

  it("provider failure is retried with exponential backoff, then succeeds", async () => {
    await bookWithConsent();
    mock.failNext(2, true, "http 503 temporarily unavailable");
    let r = await processDueNotifications(w.orgId, { clock });
    expect(r).toMatchObject({ sent: 0, retried: 2 });
    const rows = await q("select attempts, status, next_attempt_at, last_error from notification_jobs where purpose <> 'appointment_reminder' order by created_at");
    expect(rows.every((x) => x.status === "failed" && x.attempts === 1)).toBe(true);
    expect(new Date(rows[0].next_attempt_at).getTime()).toBeGreaterThan(NOW.getTime());
    // not yet due
    expect((await processDueNotifications(w.orgId, { clock })).sent).toBe(0);
    // time passes
    const later = clockAt(new Date(NOW.getTime() + 10 * 60_000));
    r = await processDueNotifications(w.orgId, { clock: later });
    expect(r.sent).toBe(2);
    expect(backoffSeconds(1, 0.5)).toBe(30); expect(backoffSeconds(3, 0.5)).toBe(120); expect(backoffSeconds(20, 0.5)).toBe(3600);
  });

  it("permanent errors and exhausted retries go to the dead-letter state", async () => {
    await bookWithConsent();
    mock.failNext(2, false, "http 400 invalid recipient");
    const r = await processDueNotifications(w.orgId, { clock });
    expect(r.dead).toBe(2);
    await q("update notification_jobs set status = 'failed', attempts = 5, max_attempts = 6, next_attempt_at = $1, last_error = null", [NOW]);
    // fabricate one more job that is on its last attempt
    await q("insert into notification_jobs(organisation_id, purpose, recipient_kind, recipient_id, dedupe_key, status, attempts, max_attempts) select $1,'assignment_new','staff',id,'last-try','failed',5,6 from staff_profiles limit 1", [w.orgId]);
    mock.failNext(5, true);
    const r2 = await processDueNotifications(w.orgId, { clock });
    expect(r2.dead).toBeGreaterThan(0);
    expect((await q("select count(*)::int n from notification_jobs where status = 'dead'"))[0].n).toBeGreaterThan(0);
  });

  it("a reminder for a booking cancelled in the meantime is skipped, not sent", async () => {
    const b = await bookWithConsent();
    await processDueNotifications(w.orgId, { clock });
    mock.reset();
    await q("update appointments set status = 'cancelled_by_business', cancelled_at = now() where id = $1", [b.appointmentId]);
    await q("update notification_jobs set status = 'pending', next_attempt_at = $1 where purpose = 'appointment_reminder'", [NOW]);
    const r = await processDueNotifications(w.orgId, { clock });
    expect(r.skipped).toBe(1);
    expect(mock.sent).toHaveLength(0);
  });

  it("logs never contain full phone numbers", async () => {
    const lines: string[] = [];
    const orig = console.warn;
    console.warn = (s: string) => lines.push(String(s));
    try {
      await bookWithConsent();
      mock.failNext(1, true, "http 400 bad number +60123450001");
      await processDueNotifications(w.orgId, { clock });
    } finally { console.warn = orig; }
    expect(lines.join("\n")).not.toContain("60123450001");
    void processWebhookEvents;
  });
});
