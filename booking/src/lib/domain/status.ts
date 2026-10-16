export const APPOINTMENT_STATUSES = [
  "draft",
  "slot_held",
  "pending_confirmation",
  "confirmed",
  "checked_in",
  "in_progress",
  "completed",
  "no_show",
  "cancelled_by_customer",
  "cancelled_by_business",
  "replacement_pending",
  "rescheduled",
  "expired",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Must match appointment_status_transitions in the database (a test compares them). */
export const TRANSITIONS: Readonly<Record<AppointmentStatus, readonly AppointmentStatus[]>> = {
  draft: ["slot_held", "pending_confirmation", "confirmed", "cancelled_by_business"],
  slot_held: ["pending_confirmation", "confirmed", "expired", "cancelled_by_customer", "cancelled_by_business"],
  pending_confirmation: ["confirmed", "expired", "cancelled_by_customer", "cancelled_by_business"],
  confirmed: [
    "checked_in",
    "in_progress",
    "completed",
    "no_show",
    "cancelled_by_customer",
    "cancelled_by_business",
    "replacement_pending",
    "rescheduled",
  ],
  checked_in: ["in_progress", "cancelled_by_customer", "cancelled_by_business"],
  in_progress: ["completed", "cancelled_by_business"],
  completed: [],
  no_show: [],
  cancelled_by_customer: [],
  cancelled_by_business: [],
  replacement_pending: ["confirmed", "cancelled_by_customer", "cancelled_by_business", "rescheduled"],
  rescheduled: [],
  expired: [],
};

export const canTransition = (from: AppointmentStatus, to: AppointmentStatus): boolean => TRANSITIONS[from].includes(to);

/** Statuses that occupy the calendar (mirror of the exclusion-constraint predicate). */
export const BLOCKING_STATUSES: readonly AppointmentStatus[] = [
  "slot_held",
  "pending_confirmation",
  "confirmed",
  "checked_in",
  "in_progress",
  "completed",
  "replacement_pending",
];
export const isBlocking = (s: AppointmentStatus): boolean => BLOCKING_STATUSES.includes(s);

/** Statuses a staff member can still act on operationally. */
export const LIVE_STATUSES: readonly AppointmentStatus[] = ["confirmed", "checked_in", "in_progress", "replacement_pending", "pending_confirmation"];
