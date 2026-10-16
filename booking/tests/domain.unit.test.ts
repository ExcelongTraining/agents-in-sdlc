import { describe, expect, it } from "vitest";
import { computeSlots, groupByStart, type AvailabilityInput } from "@/lib/domain/availability";
import { rankCandidates } from "@/lib/domain/allocation";
import { availableMinutes, computeMetric, pace, progress, type WorkRecord } from "@/lib/domain/kpi";
import { APPOINTMENT_STATUSES, canTransition, TRANSITIONS } from "@/lib/domain/status";
import { maskPhone, maskPhonesInText, normalisePhone } from "@/lib/domain/phone";
import { can, permissionsFor } from "@/lib/domain/rbac";
import { periodBounds, rangesOverlap, localDateTime } from "@/lib/domain/time";
import { at } from "./helpers/world-lite";

const base = (over: Partial<AvailabilityInput> = {}): AvailabilityInput => ({
  tz: "Asia/Kuala_Lumpur",
  fromDate: "2030-03-11",
  toDate: "2030-03-11",
  now: new Date("2030-03-04T02:00:00Z"),
  service: { durationMinutes: 60, bufferBeforeMinutes: 0, bufferAfterMinutes: 10, requiresRoom: false },
  businessHours: [{ weekday: 1, start: "09:00", end: "21:00" }],
  staff: [{ staffId: "a", workingHours: [{ weekday: 1, start: "10:00:00", end: "13:00:00" }] }],
  exceptions: [],
  busy: [],
  rooms: [],
  roomBusy: [],
  rules: { stepMinutes: 30, minNoticeMinutes: 120, maxAdvanceDays: 60, enforceNotice: true },
  ...over,
});
const starts = (s: ReturnType<typeof computeSlots>) => s.map((x) => x.startAt.toISOString());

describe("computeSlots", () => {
  it("offers grid-aligned starts whose service fits the working window", () => {
    expect(starts(computeSlots(base()))).toEqual(
      [
        at("2030-03-11", "10:00"),
        at("2030-03-11", "10:30"),
        at("2030-03-11", "11:00"),
        at("2030-03-11", "11:30"),
        at("2030-03-11", "12:00"),
      ].map((d) => d.toISOString()),
    );
  });
  it("respects buffers around existing bookings", () => {
    const busy = [{ staffId: "a", start: at("2030-03-11", "10:00"), end: at("2030-03-11", "11:10") }];
    expect(starts(computeSlots(base({ busy })))[0]).toBe(at("2030-03-11", "11:30").toISOString()); // 11:10 not on grid
  });
  it("blocks leave and branch closures", () => {
    const ex = [{ staffId: null, start: at("2030-03-11", "10:00"), end: at("2030-03-11", "12:00") }];
    expect(starts(computeSlots(base({ exceptions: ex })))).toEqual([at("2030-03-11", "12:00").toISOString()]);
  });
  it("enforces minimum notice and maximum advance only when asked", () => {
    const soon = base({ now: at("2030-03-11", "09:00") }); // 10:00 slot is 1h away, notice is 2h
    expect(starts(computeSlots(soon))[0]).toBe(at("2030-03-11", "11:00").toISOString());
    expect(computeSlots({ ...soon, rules: { ...soon.rules, enforceNotice: false } })[0]!.startAt).toEqual(
      at("2030-03-11", "10:00"),
    );
    expect(
      computeSlots(
        base({
          fromDate: "2030-09-02",
          toDate: "2030-09-02",
          businessHours: [{ weekday: 1, start: "09:00", end: "21:00" }],
        }),
      ),
    ).toEqual([]);
  });
  it("intersects staff hours with business hours and needs a free room when required", () => {
    const s = computeSlots(base({ businessHours: [{ weekday: 1, start: "11:00", end: "21:00" }] }));
    expect(starts(s)[0]).toBe(at("2030-03-11", "11:00").toISOString());
    const room = base({
      service: { ...base().service, requiresRoom: true },
      rooms: ["r1"],
      roomBusy: [{ roomId: "r1", start: at("2030-03-11", "10:00"), end: at("2030-03-11", "12:00") }],
    });
    expect(starts(computeSlots(room))).toEqual([at("2030-03-11", "12:00").toISOString()]);
  });
  it("groups 'any available' by start time", () => {
    const s = computeSlots(
      base({
        staff: [
          { staffId: "a", workingHours: [{ weekday: 1, start: "10:00", end: "12:00" }] },
          { staffId: "b", workingHours: [{ weekday: 1, start: "10:00", end: "11:00" }] },
        ],
      }),
    );
    const g = groupByStart(s);
    expect(g[0]!.staffIds).toEqual(["a", "b"]);
  });
  it("a midnight in Kuala Lumpur is the previous day in UTC", () => {
    expect(localDateTime("2030-03-11", "00:00").toISOString()).toBe("2030-03-10T16:00:00.000Z");
    expect(periodBounds("day", new Date("2030-03-10T17:00:00Z")).startDate).toBe("2030-03-11");
  });
  it("overlap is half-open: touching ranges do not overlap", () => {
    expect(
      rangesOverlap(
        at("2030-03-11", "10:00"),
        at("2030-03-11", "11:00"),
        at("2030-03-11", "11:00"),
        at("2030-03-11", "12:00"),
      ),
    ).toBe(false);
    expect(
      rangesOverlap(
        at("2030-03-11", "10:00"),
        at("2030-03-11", "11:01"),
        at("2030-03-11", "11:00"),
        at("2030-03-11", "12:00"),
      ),
    ).toBe(true);
  });
});

describe("fair allocation", () => {
  const c = (staffId: string, mins: number, extra: object = {}) => ({
    staffId,
    allocatedMinutes: mins,
    fairnessWeight: 1,
    lastAssignedAt: null,
    adjacentChainMinutes: 0,
    maxConsecutiveMinutes: null,
    ...extra,
  });
  it("ranks by lowest weighted load", () => {
    expect(
      rankCandidates([c("a", 300), c("b", 120), c("c", 240)], { serviceMinutes: 60 }).map((r) => r.staffId),
    ).toEqual(["b", "c", "a"]);
  });
  it("applies the fairness weight", () => {
    expect(
      rankCandidates([c("a", 300, { fairnessWeight: 2 }), c("b", 200)], { serviceMinutes: 60 })[0]!.staffId,
    ).toBe("a"); // 150 vs 200
  });
  it("breaks ties by least recently assigned, then id, deterministically", () => {
    const old = new Date("2030-01-01"),
      recent = new Date("2030-02-01");
    expect(
      rankCandidates([c("b", 100, { lastAssignedAt: recent }), c("a", 100, { lastAssignedAt: old })], {
        serviceMinutes: 60,
      })[0]!.staffId,
    ).toBe("a");
    expect(rankCandidates([c("b", 100), c("a", 100)], { serviceMinutes: 60 }).map((r) => r.staffId)).toEqual([
      "a",
      "b",
    ]);
  });
  it("excludes anyone who would exceed the consecutive-work limit", () => {
    const r = rankCandidates([c("a", 0, { adjacentChainMinutes: 200 }), c("b", 500)], {
      serviceMinutes: 60,
      defaultMaxConsecutiveMinutes: 240,
    });
    expect(r.map((x) => x.staffId)).toEqual(["b"]);
    expect(
      rankCandidates([c("a", 0, { adjacentChainMinutes: 200, maxConsecutiveMinutes: 300 })], {
        serviceMinutes: 60,
        defaultMaxConsecutiveMinutes: 240,
      }),
    ).toHaveLength(1);
  });
  it("optionally honours the customer's preferred masseuse", () => {
    expect(
      rankCandidates([c("a", 0), c("b", 500)], { serviceMinutes: 60, preferredStaffId: "b" })[0]!.staffId,
    ).toBe("b");
  });
  it("explains every decision", () => {
    expect(rankCandidates([c("a", 120)], { serviceMinutes: 60 })[0]!.reason).toContain(
      "weighted load 120 min",
    );
  });
});

describe("status machine", () => {
  it("terminal states have no exits and every target is a known status", () => {
    for (const s of [
      "completed",
      "no_show",
      "cancelled_by_customer",
      "cancelled_by_business",
      "rescheduled",
      "expired",
    ] as const)
      expect(TRANSITIONS[s]).toEqual([]);
    for (const [, tos] of Object.entries(TRANSITIONS))
      for (const t of tos) expect(APPOINTMENT_STATUSES).toContain(t);
  });
  it("spot checks", () => {
    expect(canTransition("confirmed", "completed")).toBe(true);
    expect(canTransition("completed", "confirmed")).toBe(false);
    expect(canTransition("slot_held", "completed")).toBe(false);
    expect(canTransition("replacement_pending", "confirmed")).toBe(true);
    expect(canTransition("in_progress", "no_show")).toBe(false);
  });
});

describe("KPI formulas", () => {
  const rec = (o: Partial<WorkRecord>): WorkRecord => ({
    appointmentId: Math.random().toString(),
    staffId: "s",
    customerId: "c1",
    status: "completed",
    kind: "service",
    countsTowardKpi: true,
    startAt: new Date(),
    scheduledMinutes: 60,
    actualMinutes: null,
    origin: "booking",
    firstVisit: false,
    ...o,
  });
  it("completed service hours come only from completed, KPI-eligible, non-consultation appointments", () => {
    const records = [
      rec({}),
      rec({ scheduledMinutes: 90 }),
      rec({ status: "confirmed" }),
      rec({ status: "cancelled_by_customer" }),
      rec({ kind: "consultation", scheduledMinutes: 20 }),
      rec({ countsTowardKpi: false }),
      rec({ kind: "trial", scheduledMinutes: 30 }),
    ];
    const m = computeMetric("completed_service_hours", { records, basis: "scheduled" });
    expect(m.value).toBe(3); // 60 + 90 + 30 minutes
    expect(m.explanation).toContain("3 completed appointment");
    expect(computeMetric("consultation_hours", { records, basis: "scheduled" }).value).toBe(0.33);
  });
  it("scheduled hours include confirmed work but not cancellations", () => {
    const records = [
      rec({ status: "confirmed" }),
      rec({ status: "completed" }),
      rec({ status: "cancelled_by_business" }),
      rec({ status: "no_show" }),
    ];
    expect(computeMetric("scheduled_service_hours", { records, basis: "scheduled" }).value).toBe(2);
    expect(computeMetric("cancelled_hours", { records, basis: "scheduled" }).value).toBe(1);
    expect(computeMetric("no_show_hours", { records, basis: "scheduled" }).value).toBe(1);
  });
  it("actual basis uses recorded minutes, falling back to scheduled", () => {
    const records = [rec({ actualMinutes: 75 }), rec({})];
    expect(computeMetric("completed_service_hours", { records, basis: "actual" }).value).toBe(2.25);
    expect(computeMetric("completed_service_hours", { records, basis: "scheduled" }).value).toBe(2);
  });
  it("counts first-time vs returning clients once per distinct client", () => {
    const records = [
      rec({ customerId: "a", firstVisit: true }),
      rec({ customerId: "a", firstVisit: true }),
      rec({ customerId: "b" }),
      rec({ customerId: "b" }),
    ];
    expect(computeMetric("first_time_clients", { records, basis: "scheduled" }).value).toBe(1);
    expect(computeMetric("returning_clients", { records, basis: "scheduled" }).value).toBe(1);
  });
  it("utilisation = completed minutes / available minutes", () => {
    const m = computeMetric("utilisation_pct", {
      records: [rec({}), rec({})],
      basis: "scheduled",
      availableMinutes: 480,
    });
    expect(m.value).toBe(25);
    expect(
      computeMetric("utilisation_pct", { records: [rec({})], basis: "scheduled", availableMinutes: 0 }).value,
    ).toBe(0);
  });
  it("replacement hours are a subset of completed hours credited to the replacement", () => {
    const records = [rec({ origin: "replacement" }), rec({})];
    expect(computeMetric("replacement_hours", { records, basis: "scheduled" }).value).toBe(1);
    expect(computeMetric("completed_service_hours", { records, basis: "scheduled" }).value).toBe(2);
  });
  it("progress example from the brief: 78 of 120 = 65%, 42 remaining", () => {
    const p = progress(78, 120);
    expect(p.progressPct).toBe(65);
    expect(p.remaining).toBe(42);
    expect(progress(130, 120).remaining).toBe(0);
    expect(progress(10, 0).progressPct).toBe(0);
  });
  it("pace compares actual with an even spread across the period", () => {
    const mid = new Date("2030-03-16T08:00:00Z"); // roughly half way through March (KL)
    expect(pace("month", mid, 10, 120, "Asia/Kuala_Lumpur").status).toBe("behind");
    expect(pace("month", mid, 70, 120, "Asia/Kuala_Lumpur").status).toBe("ahead");
  });
  it("available minutes subtract leave but not outside-window time", () => {
    const hours = [{ weekday: 1, start: "10:00", end: "18:00" }];
    const start = at("2030-03-11", "00:00"),
      end = at("2030-03-12", "00:00");
    expect(availableMinutes(hours, [], start, end, "Asia/Kuala_Lumpur")).toBe(480);
    expect(
      availableMinutes(
        hours,
        [{ start: at("2030-03-11", "12:00"), end: at("2030-03-11", "14:00") }],
        start,
        end,
        "Asia/Kuala_Lumpur",
      ),
    ).toBe(360);
    expect(
      availableMinutes(
        hours,
        [{ start: at("2030-03-10", "00:00"), end: at("2030-03-13", "00:00") }],
        start,
        end,
        "Asia/Kuala_Lumpur",
      ),
    ).toBe(0);
  });
});

describe("phone numbers", () => {
  it("normalises Malaysian formats to E.164", () => {
    for (const n of ["012-345 6789", "0123456789", "60123456789", "+60 12-345 6789", "0060123456789"])
      expect(normalisePhone(n)).toBe("+60123456789");
    expect(normalisePhone("+65 9123 4567")).toBe("+6591234567");
  });
  it("rejects nonsense", () => {
    for (const n of ["", "abc", "123", "0", "+0123456789", "12345678"]) expect(normalisePhone(n)).toBeNull();
  });
  it("masks numbers for logs", () => {
    expect(maskPhone("+60123456789")).toBe("+60•••••6789");
    expect(maskPhonesInText("failed for +60123456789 now")).not.toContain("123456");
  });
});

describe("role permissions", () => {
  const p = (roles: ("masseuse" | "manager" | "administrator")[]) => ({
    userId: "u",
    orgId: "o",
    staffId: null,
    roles,
    displayName: "x",
  });
  it("masseuse: own scope only", () => {
    expect(can(p(["masseuse"]), "schedule.read.own")).toBe(true);
    expect(can(p(["masseuse"]), "schedule.read.all")).toBe(false);
    expect(can(p(["masseuse"]), "appointment.override")).toBe(false);
    expect(can(p(["masseuse"]), "replacement.approve")).toBe(false);
    expect(can(p(["masseuse"]), "users.manage")).toBe(false);
  });
  it("administrator has no customer, schedule or KPI access", () => {
    for (const perm of [
      "schedule.read.all",
      "schedule.read.own",
      "customers.read",
      "kpi.read.all",
      "appointment.create.any",
    ] as const)
      expect(can(p(["administrator"]), perm)).toBe(false);
    expect(can(p(["administrator"]), "integrations.manage")).toBe(true);
    expect(permissionsFor("administrator")).toContain("audit.read");
  });
  it("manager can configure and override", () => {
    for (const perm of [
      "appointment.override",
      "availability.approve",
      "replacement.approve",
      "services.manage",
      "users.manage",
    ] as const)
      expect(can(p(["manager"]), perm)).toBe(true);
  });
});
