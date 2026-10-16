import { DateTime, Interval } from "luxon";

export const DEFAULT_TZ = "Asia/Kuala_Lumpur";

/** All timestamps are stored in UTC; these helpers convert explicitly using the branch time zone. */
export const toLocal = (d: Date, tz = DEFAULT_TZ): DateTime => DateTime.fromJSDate(d, { zone: tz });

/** Local midnight at the start of `isoDate` (yyyy-MM-dd) in `tz`, as a UTC Date. */
export function startOfLocalDay(isoDate: string, tz = DEFAULT_TZ): Date {
  const dt = DateTime.fromISO(isoDate, { zone: tz });
  if (!dt.isValid) throw new Error(`Invalid date: ${isoDate}`);
  return dt.startOf("day").toUTC().toJSDate();
}

/** Combine a local date and wall-clock time ("HH:mm" or "HH:mm:ss") in `tz` into a UTC Date. */
export function localDateTime(isoDate: string, time: string, tz = DEFAULT_TZ): Date {
  const [h = "0", m = "0"] = time.split(":");
  const dt = DateTime.fromISO(isoDate, { zone: tz }).set({
    hour: Number(h),
    minute: Number(m),
    second: 0,
    millisecond: 0,
  });
  if (!dt.isValid) throw new Error(`Invalid local date/time: ${isoDate} ${time}`);
  return dt.toUTC().toJSDate();
}

/** ISO weekday: 1 = Monday ... 7 = Sunday (matches business_hours.weekday). */
export const isoWeekday = (isoDate: string, tz = DEFAULT_TZ): number =>
  DateTime.fromISO(isoDate, { zone: tz }).weekday;

export const addMinutes = (d: Date, minutes: number): Date => new Date(d.getTime() + minutes * 60_000);

export const minutesBetween = (a: Date, b: Date): number => Math.round((b.getTime() - a.getTime()) / 60_000);

/** Half-open interval overlap: [aStart, aEnd) and [bStart, bEnd). Touching ranges do NOT overlap. */
export const rangesOverlap = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean =>
  aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();

export function eachLocalDate(fromIso: string, toIso: string, tz = DEFAULT_TZ): string[] {
  const out: string[] = [];
  let cur = DateTime.fromISO(fromIso, { zone: tz }).startOf("day");
  const end = DateTime.fromISO(toIso, { zone: tz }).startOf("day");
  while (cur <= end) {
    out.push(cur.toISODate() as string);
    cur = cur.plus({ days: 1 });
  }
  return out;
}

export type KpiPeriod = "day" | "week" | "month";

/** [start, end) of the KPI period containing `at`, in `tz` (weeks start Monday). */
export function periodBounds(
  period: KpiPeriod,
  at: Date,
  tz = DEFAULT_TZ,
): { start: Date; end: Date; startDate: string; endDate: string } {
  const unit = period === "day" ? "day" : period === "week" ? "week" : "month";
  const s = DateTime.fromJSDate(at, { zone: tz }).startOf(unit);
  const e = s.plus({ [unit === "day" ? "days" : unit === "week" ? "weeks" : "months"]: 1 });
  return {
    start: s.toUTC().toJSDate(),
    end: e.toUTC().toJSDate(),
    startDate: s.toISODate() as string,
    endDate: e.minus({ days: 1 }).toISODate() as string,
  };
}

export const formatLocal = (d: Date, tz = DEFAULT_TZ, fmt = "EEE d MMM yyyy, h:mm a"): string =>
  toLocal(d, tz).toFormat(fmt);

export { DateTime, Interval };
