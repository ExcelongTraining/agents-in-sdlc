import { addMinutes, eachLocalDate, isoWeekday, localDateTime, rangesOverlap } from "./time";

export interface TimeWindow {
  weekday: number; // ISO 1..7
  start: string; // "HH:mm" or "HH:mm:ss"
  end: string;
}
export interface Range {
  start: Date;
  end: Date;
}
export interface StaffAvailability {
  staffId: string;
  workingHours: TimeWindow[]; // approved only
}
export interface AvailabilityInput {
  tz: string;
  fromDate: string; // local yyyy-MM-dd, inclusive
  toDate: string; // inclusive
  now: Date;
  service: { durationMinutes: number; bufferBeforeMinutes: number; bufferAfterMinutes: number; requiresRoom: boolean };
  businessHours: TimeWindow[];
  staff: StaffAvailability[]; // already filtered to qualified, active staff
  /** Approved leave/breaks/blocked time. staffId null = branch-wide closure. */
  exceptions: (Range & { staffId: string | null })[];
  /** `occupied` ranges (service + buffers) of active assignments. */
  busy: (Range & { staffId: string })[];
  rooms: string[];
  roomBusy: (Range & { roomId: string })[];
  rules: { stepMinutes: number; minNoticeMinutes: number; maxAdvanceDays: number; enforceNotice: boolean };
}
export interface Slot {
  startAt: Date;
  endAt: Date;
  staffId: string;
  roomId: string | null;
}

const toMinutes = (t: string): number => {
  const [h = "0", m = "0"] = t.split(":");
  return Number(h) * 60 + Number(m);
};

/**
 * Pure availability calculation. Mirrors the database rules (assignments_validate trigger + exclusion constraints):
 *  - the SERVICE interval must lie inside one working window AND one business-hours window of that weekday
 *  - the OCCUPIED interval (service + buffers) must not overlap other bookings, approved exceptions or branch closures
 *  - rooms: when required, at least one room must be free for the occupied interval
 * The database remains authoritative: this function only decides what to OFFER, never what is CONFIRMED.
 */
export function computeSlots(input: AvailabilityInput): Slot[] {
  const { tz, service, rules } = input;
  const earliest = rules.enforceNotice ? addMinutes(input.now, rules.minNoticeMinutes) : new Date(0);
  const latest = rules.enforceNotice ? addMinutes(input.now, rules.maxAdvanceDays * 24 * 60) : new Date(8.64e15);
  const slots: Slot[] = [];

  for (const date of eachLocalDate(input.fromDate, input.toDate, tz)) {
    const wd = isoWeekday(date, tz);
    const biz = input.businessHours.filter((b) => b.weekday === wd);
    if (biz.length === 0) continue;
    for (const st of input.staff) {
      const staffExceptions = input.exceptions.filter((e) => e.staffId === null || e.staffId === st.staffId);
      const staffBusy = input.busy.filter((b) => b.staffId === st.staffId);
      for (const w of st.workingHours.filter((x) => x.weekday === wd)) {
        for (const b of biz) {
          const winStart = Math.max(toMinutes(w.start), toMinutes(b.start));
          const winEnd = Math.min(toMinutes(w.end), toMinutes(b.end));
          // first grid-aligned minute-of-day >= winStart
          let m = Math.ceil(winStart / rules.stepMinutes) * rules.stepMinutes;
          for (; m + service.durationMinutes <= winEnd; m += rules.stepMinutes) {
            const startAt = localDateTime(date, `${Math.floor(m / 60)}:${m % 60}`, tz);
            if (startAt < earliest || startAt > latest) continue;
            const endAt = addMinutes(startAt, service.durationMinutes);
            const occStart = addMinutes(startAt, -service.bufferBeforeMinutes);
            const occEnd = addMinutes(endAt, service.bufferAfterMinutes);
            if (staffExceptions.some((e) => rangesOverlap(occStart, occEnd, e.start, e.end))) continue;
            if (staffBusy.some((x) => rangesOverlap(occStart, occEnd, x.start, x.end))) continue;
            let roomId: string | null = null;
            if (service.requiresRoom) {
              roomId = input.rooms.find((r) => !input.roomBusy.some((x) => x.roomId === r && rangesOverlap(occStart, occEnd, x.start, x.end))) ?? null;
              if (!roomId) continue;
            }
            slots.push({ startAt, endAt, staffId: st.staffId, roomId });
          }
        }
      }
    }
  }
  return slots.sort((a, b) => a.startAt.getTime() - b.startAt.getTime() || a.staffId.localeCompare(b.staffId));
}

export interface GroupedSlot {
  startAt: Date;
  endAt: Date;
  staffIds: string[];
}

/** "Any available masseuse" view: one entry per start time with all staff who could take it. */
export function groupByStart(slots: Slot[]): GroupedSlot[] {
  const map = new Map<number, GroupedSlot>();
  for (const s of slots) {
    const key = s.startAt.getTime();
    const g = map.get(key);
    if (g) g.staffIds.push(s.staffId);
    else map.set(key, { startAt: s.startAt, endAt: s.endAt, staffIds: [s.staffId] });
  }
  return [...map.values()];
}

/** Closest alternative start times (same staff) to a requested time, used when the first choice is unavailable. */
export function nearestSlots(slots: Slot[], target: Date, limit = 4): Slot[] {
  return [...slots].sort((a, b) => Math.abs(a.startAt.getTime() - target.getTime()) - Math.abs(b.startAt.getTime() - target.getTime())).slice(0, limit);
}
