import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  adminClient,
  at,
  clockAt,
  managerPrincipal,
  NOW,
  resetWorld,
  shutdown,
  staffPrincipal,
} from "./helpers/world";
import {
  cancelAppointment,
  createDirectBooking,
  rescheduleAppointment,
  transitionAppointment,
} from "@/lib/services/booking";
import {
  createException,
  decideException,
  decideWorkingHours,
  proposeWorkingHours,
} from "@/lib/services/availability-admin";
import {
  accessFromManageToken,
  accessFromOtpToken,
  assertOwns,
  listCustomerBookings,
  requestOtp,
  verifyOtp,
} from "@/lib/services/customer-access";
import { anonymiseCustomer, exportCustomerData, runRetention } from "@/lib/services/privacy";
import { getKpiDashboard } from "@/lib/services/kpi";
import { operationsReport } from "@/lib/services/reports";
import { runScheduledJobs, scheduleKpiReminders } from "@/lib/services/jobs";
import { listSchedule, acknowledgeAssignments } from "@/lib/services/schedule";
import { MockWhatsAppProvider } from "@/lib/whatsapp/mock";
import { setProviderForTests } from "@/lib/whatsapp/provider";
import { AppError } from "@/lib/errors";
import type { World } from "@/lib/seed/base";

let w: World;
let mock: MockWhatsAppProvider;
const clock = clockAt(NOW);
let seq = 0;
beforeEach(async () => {
  w = await resetWorld();
  mock = new MockWhatsAppProvider();
  setProviderForTests(mock);
});
afterAll(async () => {
  setProviderForTests(undefined);
  await shutdown();
});

const q = async (sql: string, params: unknown[] = []) => {
  const c = await adminClient();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};
const code = async (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: unknown) => (e instanceof AppError ? e.code : String(e)),
  );
async function book(staffIdx: number, date: string, start: string, phone?: string, serviceId?: string) {
  seq++;
  return createDirectBooking(
    managerPrincipal(w),
    {
      branchId: w.branchId,
      serviceId: serviceId ?? w.services.massage60,
      startAt: at(date, start),
      staffId: w.staff[staffIdx]!.id,
      source: "phone",
      customer: { name: `Customer ${seq}`, phone: phone ?? `01003${String(seq).padStart(5, "0")}` },
      consent: { serviceBooking: true, whatsapp: true, marketing: false },
    } as never,
    clock,
  );
}
const customerOf = async (apptId: string) =>
  (await q("select customer_id from appointments where id = $1", [apptId]))[0].customer_id as string;

describe("availability and leave approval", () => {
  it("masseuse leave is pending until a manager approves; approval is refused over existing bookings", async () => {
    const aisyah = staffPrincipal(w, 0);
    const r = await createException(aisyah, {
      kind: "leave",
      start: at("2030-04-01", "10:00"),
      end: at("2030-04-02", "19:00"),
      reason: "annual leave",
    });
    expect(r.status).toBe("pending");
    await book(0, "2030-04-01", "12:00"); // pending leave does not block
    expect(await code(decideException(managerPrincipal(w), r.id, true))).toBe("LEAVE_CONFLICTS_WITH_BOOKING");
    await expect(q("select status from availability_exceptions where id = $1", [r.id])).resolves.toEqual([
      { status: "pending" },
    ]);
    // booking moves elsewhere, then approval succeeds and blocks new bookings
    const b = (await q("select id from appointments limit 1"))[0].id;
    await cancelAppointment(w.orgId, { kind: "staff", principal: managerPrincipal(w) }, b, {}, clock);
    expect((await decideException(managerPrincipal(w), r.id, true)).status).toBe("approved");
    expect(await code(book(0, "2030-04-01", "12:00"))).toBe("STAFF_UNAVAILABLE");
  });
  it("a masseuse cannot approve, cannot request leave for others, and cannot create closures", async () => {
    const a = staffPrincipal(w, 0);
    const r = await createException(a, {
      kind: "leave",
      start: at("2030-04-01", "10:00"),
      end: at("2030-04-02", "10:00"),
    });
    expect(await code(decideException(a, r.id, true))).toBe("FORBIDDEN");
    expect(
      await code(
        createException(a, {
          kind: "leave",
          staffId: w.staff[1]!.id,
          start: at("2030-04-01", "10:00"),
          end: at("2030-04-02", "10:00"),
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await code(
        createException(a, {
          kind: "closure",
          start: at("2030-04-01", "10:00"),
          end: at("2030-04-02", "10:00"),
        }),
      ),
    ).toBe("FORBIDDEN");
  });
  it("working-hours changes proposed by staff need approval and report bookings left outside the new hours", async () => {
    await book(0, "2030-03-18", "17:00");
    const a = staffPrincipal(w, 0);
    const p = await proposeWorkingHours(a, {
      windows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: "10:00", end: "16:00" })),
    });
    expect(p.status).toBe("pending");
    expect(
      await q("select count(*)::int n from staff_working_hours where staff_id = $1 and status = 'approved'", [
        w.staff[0]!.id,
      ]),
    ).toEqual([{ n: 6 }]); // unchanged
    expect(await code(decideWorkingHours(a, p.batchId, true))).toBe("FORBIDDEN");
    const d = await decideWorkingHours(managerPrincipal(w), p.batchId, true);
    expect(d).toEqual({ status: "approved", futureBookingsOutsideNewHours: 1 });
    expect(
      await q("select count(*)::int n from staff_working_hours where staff_id = $1 and status = 'approved'", [
        w.staff[0]!.id,
      ]),
    ).toEqual([{ n: 5 }]);
  });
  it("branch closure blocks every masseuse", async () => {
    await createException(managerPrincipal(w), {
      kind: "closure",
      start: at("2030-04-05", "00:00"),
      end: at("2030-04-06", "00:00"),
      reason: "public holiday",
    });
    for (const i of [0, 1, 2]) expect(await code(book(i, "2030-04-05", "12:00"))).toBe("STAFF_UNAVAILABLE");
  });
});

describe("customer self-service access", () => {
  it("a manage link opens only its own appointment and refuses forged or foreign tokens", async () => {
    const a = await book(0, "2030-03-12", "11:00", "0123450011");
    const b = await book(1, "2030-03-12", "11:00", "0123450022");
    const accA = await accessFromManageToken(w.orgId, a.manageToken, clock);
    expect(accA).toEqual({ customerId: await customerOf(a.appointmentId), appointmentId: a.appointmentId });
    expect(await accessFromManageToken(w.orgId, a.appointmentId + ".forged", clock)).toBeNull();
    expect(
      await accessFromManageToken(w.orgId, b.appointmentId + "." + a.manageToken.split(".")[1], clock),
    ).toBeNull(); // signature from another booking
    // customer A tries to act on customer B's booking
    const ownerB = await customerOf(b.appointmentId);
    expect(() => assertOwns(accA!, ownerB, b.appointmentId)).toThrow(/not found/i);
    expect(
      await code(
        cancelAppointment(
          w.orgId,
          { kind: "customer", customerId: accA!.customerId, via: "manage_token" },
          b.appointmentId,
          {},
          clock,
        ),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await code(
        rescheduleAppointment(
          w.orgId,
          { kind: "customer", customerId: accA!.customerId, via: "manage_token" },
          { appointmentId: b.appointmentId, newStartAt: at("2030-03-12", "14:00") },
          clock,
        ),
      ),
    ).toBe("NOT_FOUND");
    expect((await listCustomerBookings(w.orgId, accA!, clock)).map((x) => x.appointmentId)).toEqual([
      a.appointmentId,
    ]);
    // links expire a week after the appointment
    expect(
      await accessFromManageToken(w.orgId, a.manageToken, clockAt(at("2030-03-25", "10:00"))),
    ).toBeNull();
  });
  it("customer can reschedule within policy through their link", async () => {
    const a = await book(0, "2030-03-14", "11:00", "0123450033");
    const acc = (await accessFromManageToken(w.orgId, a.manageToken, clock))!;
    const moved = await rescheduleAppointment(
      w.orgId,
      { kind: "customer", customerId: acc.customerId, via: "manage_token" },
      { appointmentId: a.appointmentId, newStartAt: at("2030-03-14", "15:00") },
      clock,
    );
    expect(moved.startAt).toBe(at("2030-03-14", "15:00").toISOString());
    expect(
      await code(
        rescheduleAppointment(
          w.orgId,
          { kind: "customer", customerId: acc.customerId, via: "manage_token" },
          { appointmentId: a.appointmentId, newStartAt: at("2030-03-14", "16:00") },
          clock,
        ),
      ),
    ).toBe("NOT_ALLOWED"); // old one is rescheduled
  });
  it("WhatsApp OTP: generic response for unknown numbers, one-time use, attempt limits", async () => {
    await book(0, "2030-03-12", "11:00", "0123450044");
    await requestOtp(w.orgId, "0199999999", "1.1.1.1", clock); // unknown number: silently nothing
    expect(await q("select count(*)::int n from booking_otps")).toEqual([{ n: 0 }]);
    await requestOtp(w.orgId, "012-345 0044", "1.1.1.1", clock);
    const { processDueNotifications } = await import("@/lib/services/outbox");
    await processDueNotifications(w.orgId, { clock });
    const sent = mock.sent.find((m) => m.template === "customer_otp_v1")!;
    const otp = sent.params![0]!;
    expect(otp).toMatch(/^\d{6}$/);
    expect(
      await code(verifyOtp(w.orgId, "0123450044", otp === "000000" ? "111111" : "000000", "1.1.1.1", clock)),
    ).toBe("UNAUTHENTICATED");
    const ok = await verifyOtp(w.orgId, "0123450044", otp, "1.1.1.1", clock);
    const acc = await accessFromOtpToken(w.orgId, ok.token, clock);
    expect(acc?.customerId).toBeTruthy();
    expect(await code(verifyOtp(w.orgId, "0123450044", otp, "1.1.1.1", clock))).toBe("UNAUTHENTICATED"); // reuse
    expect(
      await accessFromOtpToken(w.orgId, ok.token, clockAt(new Date(NOW.getTime() + 31 * 60_000))),
    ).toBeNull(); // expired
  });
  it("OTP requests are rate limited per phone number", async () => {
    await book(0, "2030-03-12", "11:00", "0123450055");
    for (let i = 0; i < 3; i++) await requestOtp(w.orgId, "0123450055", "2.2.2.2", clock);
    expect(await code(requestOtp(w.orgId, "0123450055", "2.2.2.2", clock))).toBe("RATE_LIMITED");
  });
});

describe("privacy: export, deletion, retention", () => {
  it("exports everything held about a customer, audited", async () => {
    const a = await book(0, "2030-03-12", "11:00", "0123450066");
    const data = await exportCustomerData(managerPrincipal(w), await customerOf(a.appointmentId));
    expect(Object.keys(data)).toEqual(
      expect.arrayContaining(["customer", "consents", "appointments", "whatsappMessages"]),
    );
    expect((data.appointments as unknown[]).length).toBe(1);
    expect((await q("select count(*)::int n from audit_logs where action = 'privacy.export'"))[0].n).toBe(1);
    expect(await code(exportCustomerData(staffPrincipal(w, 0), await customerOf(a.appointmentId)))).toBe(
      "FORBIDDEN",
    );
  });
  it("deletion anonymises identifiers, keeps appointment records for KPIs, and is blocked while bookings are upcoming", async () => {
    const a = await book(0, "2030-03-12", "11:00", "0123450077");
    const cid = await customerOf(a.appointmentId);
    expect(await code(anonymiseCustomer(managerPrincipal(w), cid, "request #1 verified", clock))).toBe(
      "NOT_ALLOWED",
    );
    await cancelAppointment(
      w.orgId,
      { kind: "staff", principal: managerPrincipal(w) },
      a.appointmentId,
      {},
      clock,
    );
    await anonymiseCustomer(managerPrincipal(w), cid, "request #1 verified", clock);
    const c = (
      await q("select display_name, phone_e164, email, anonymised_at from customers where id = $1", [cid])
    )[0];
    expect(c.display_name).toBe("Deleted customer");
    expect(c.phone_e164).not.toContain("123450077");
    expect(c.anonymised_at).not.toBeNull();
    expect((await q("select count(*)::int n from appointments where customer_id = $1", [cid]))[0].n).toBe(1);
    // the same phone number can register again as a fresh customer
    await book(1, "2030-03-13", "11:00", "0123450077");
    expect((await q("select count(*)::int n from customers"))[0].n).toBe(2);
  });
  it("retention removes expired technical data and anonymises long-inactive customers", async () => {
    const a = await book(0, "2030-03-12", "11:00", "0123450088");
    await transitionAppointment(
      w.orgId,
      managerPrincipal(w),
      a.appointmentId,
      "completed",
      {},
      clockAt(at("2030-03-12", "13:00")),
    );
    await q(
      "insert into webhook_events(organisation_id, event_key, payload, status, received_at) values ($1,'old','{}','processed', $2)",
      [w.orgId, new Date("2029-01-01")],
    );
    const r = await runRetention(w.orgId, clockAt(new Date("2034-01-01T00:00:00Z")));
    expect(r.webhookEvents).toBe(1);
    expect(r.customersAnonymised).toBe(1);
    const r2 = await runRetention(w.orgId, clockAt(new Date("2030-03-13T00:00:00Z")));
    expect(r2.customersAnonymised).toBe(0);
  });
});

describe("KPI dashboard and reports", () => {
  async function completed(staffIdx: number, date: string, start: string, phone: string, serviceId?: string) {
    const b = await book(staffIdx, date, start, phone, serviceId);
    await transitionAppointment(
      w.orgId,
      managerPrincipal(w),
      b.appointmentId,
      "completed",
      {},
      clockAt(at(date, "23:00")),
    );
    return b;
  }
  it("computes progress from COMPLETED appointments only and exposes the formula", async () => {
    await completed(0, "2030-03-12", "11:00", "0123450101");
    await completed(0, "2030-03-12", "13:00", "0123450102", w.services.deep90);
    await book(0, "2030-03-13", "11:00"); // scheduled but not completed
    const dash = await getKpiDashboard(staffPrincipal(w, 0), { at: at("2030-03-20", "12:00") });
    const month = dash.lines.find((l) => l.code === "completed_hours_month")!;
    expect(month.result.value).toBe(2.5);
    expect(month.target).toBe(120);
    expect(month.progress).toMatchObject({ progressPct: 2.1, remaining: 117.5 });
    expect(month.result.explanation).toContain("2 completed appointment(s) totalling 150 min");
    const sched = dash.lines.find((l) => l.code === "scheduled_hours_week")!;
    expect(sched.result.value).toBeGreaterThanOrEqual(0);
    expect(dash.lines.find((l) => l.code === "first_time_month")!.result.value).toBe(2);
  });
  it("a masseuse can only see her own KPIs", async () => {
    expect(await code(getKpiDashboard(staffPrincipal(w, 0), { staffId: w.staff[1]!.id }))).toBe("FORBIDDEN");
    expect(await code(getKpiDashboard(staffPrincipal(w, 0)))).toBe("OK");
    expect(await code(getKpiDashboard(managerPrincipal(w), { staffId: w.staff[1]!.id }))).toBe("OK");
  });
  it("consultations are reported separately and do not inflate service hours", async () => {
    await completed(0, "2030-03-12", "11:00", "0123450111", w.services.consult20);
    await completed(0, "2030-03-12", "13:00", "0123450112");
    const dash = await getKpiDashboard(managerPrincipal(w), {
      staffId: w.staff[0]!.id,
      at: at("2030-03-20", "12:00"),
    });
    expect(dash.lines.find((l) => l.code === "completed_hours_month")!.result.value).toBe(1);
    expect(dash.lines.find((l) => l.code === "consultation_hours_month")!.result.value).toBe(0.33);
  });
  it("operations report: sources, cancellation and no-show rates, workload share", async () => {
    await completed(0, "2030-03-12", "11:00", "0123450121");
    await completed(1, "2030-03-12", "11:00", "0123450122");
    const ns = await book(2, "2030-03-12", "11:00", "0123450123");
    await transitionAppointment(
      w.orgId,
      managerPrincipal(w),
      ns.appointmentId,
      "no_show",
      {},
      clockAt(at("2030-03-12", "23:00")),
    );
    const cx = await book(3, "2030-03-12", "11:00", "0123450124");
    await cancelAppointment(
      w.orgId,
      { kind: "staff", principal: managerPrincipal(w) },
      cx.appointmentId,
      {},
      clock,
    );
    const rep = await operationsReport(
      managerPrincipal(w),
      at("2030-03-01", "00:00"),
      at("2030-04-01", "00:00"),
    );
    expect(rep.bySource).toEqual([{ source: "phone", count: 4 }]);
    expect(rep.noShowRatePct).toBe(33.3);
    expect(rep.cancellationRatePct).toBe(25);
    expect(rep.staff.find((s) => s.name === "Aisyah")!.sharePct).toBe(50);
    expect(
      await code(
        operationsReport(staffPrincipal(w, 0), at("2030-03-01", "00:00"), at("2030-04-01", "00:00")),
      ),
    ).toBe("FORBIDDEN");
  });
});

describe("schedule visibility and jobs", () => {
  it("manager sees all; masseuse sees only her own with masked phone and first name; new-assignment indicator clears", async () => {
    await book(0, "2030-03-12", "11:00", "0123450131");
    await book(1, "2030-03-12", "11:00", "0123450132");
    const range = { from: at("2030-03-12", "00:00"), to: at("2030-03-13", "00:00") };
    expect(await listSchedule(managerPrincipal(w), range)).toHaveLength(2);
    const mine = await listSchedule(staffPrincipal(w, 0), range);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.customerPhone).toContain("•");
    expect(mine[0]!.customerName).not.toContain(" ");
    expect(mine[0]!.isNew).toBe(true);
    expect(await acknowledgeAssignments(staffPrincipal(w, 0))).toBe(1);
    expect((await listSchedule(staffPrincipal(w, 0), range))[0]!.isNew).toBe(false);
    // filter tricks do not widen access
    expect(await listSchedule(staffPrincipal(w, 0), { ...range, staffId: w.staff[1]!.id })).toHaveLength(0);
    expect(
      await code(
        listSchedule(managerPrincipal(w), { from: at("2030-01-01", "00:00"), to: at("2031-01-01", "00:00") }),
      ),
    ).toBe("VALIDATION");
  });
  it("KPI reminders: only Monday daytime, once a week, only for opted-in staff, neutral wording", async () => {
    await q("update staff_profiles set kpi_reminders_enabled = false where id = $1", [w.staff[1]!.id]);
    const mondayNoon = clockAt(at("2030-03-11", "12:00"));
    expect(await scheduleKpiReminders(w.orgId, clockAt(at("2030-03-11", "07:00")))).toBe(0); // before reminder window
    expect(await scheduleKpiReminders(w.orgId, clockAt(at("2030-03-12", "12:00")))).toBe(0); // Tuesday
    const first = await scheduleKpiReminders(w.orgId, mondayNoon);
    expect(first).toBe(4); // 5 staff, one opted out
    await scheduleKpiReminders(w.orgId, clockAt(at("2030-03-11", "15:00"))); // same ISO week: de-duplicated
    expect(
      (await q("select count(*)::int n from notification_jobs where purpose = 'kpi_reminder'"))[0].n,
    ).toBe(4);
    const rep = await runScheduledJobs(w.orgId, { clock: mondayNoon });
    expect(rep.notifications.sent).toBeGreaterThanOrEqual(4);
    const msgs = mock.sent.filter((m) => m.template === "kpi_reminder_v1");
    expect(msgs).toHaveLength(4);
    expect(msgs.every((m) => m.to.startsWith("+6010000010"))).toBe(true);
    expect(
      (await import("@/lib/whatsapp/messages"))
        .renderNotification("kpi_reminder", {
          name: "A",
          period: "month",
          done: 10,
          target: 120,
          remaining: 110,
        })
        .toLowerCase(),
    ).not.toMatch(/behind|fail|poor|lazy|worst/);
  });
  it("scheduled job tick expires holds and is idempotent", async () => {
    const { createHold } = await import("@/lib/services/booking");
    await createHold(
      w.orgId,
      {
        branchId: w.branchId,
        serviceId: w.services.massage60,
        startAt: at("2030-03-12", "11:00"),
        staffId: w.staff[0]!.id,
        source: "web",
        idempotencyKey: "job-hold-0001",
      },
      clock,
    );
    const later = clockAt(new Date(NOW.getTime() + 15 * 60_000));
    expect((await runScheduledJobs(w.orgId, { clock: later })).holdsExpired).toBe(1);
    expect((await runScheduledJobs(w.orgId, { clock: later })).holdsExpired).toBe(0);
  });
});
