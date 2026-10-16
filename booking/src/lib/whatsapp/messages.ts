import type { NotificationPurpose } from "../services/notifications";

/**
 * Plain-text renderings of each notification, used (a) by the mock provider and tests and (b) as the free-form
 * fallback ONLY while the customer-service window is open. Out-of-window sends must use an approved template.
 * Wording is deliberately neutral and non-punitive (KPI messages especially).
 */
type P = Record<string, string | number>;
const r: Record<NotificationPurpose, (p: P) => string> = {
  booking_request_received: (p) => `Hi ${p.customer}, we received your request for ${p.service} on ${p.date} at ${p.time}. We'll confirm shortly.`,
  slot_held: (p) => `We're holding ${p.date} ${p.time} for you for a few minutes. Please complete your booking.`,
  booking_confirmed: (p) => `Hi ${p.customer}, your ${p.service} with ${p.staff} is confirmed for ${p.date} at ${p.time} at ${p.branch}. To change or cancel, use your booking link.`,
  booking_changed: (p) => `Hi ${p.customer}, your booking has been updated: ${p.service} with ${p.staff} on ${p.date} at ${p.time}.`,
  booking_cancelled: (p) => `Hi ${p.customer}, your booking for ${p.date} at ${p.time} has been cancelled. Reply BOOK to make a new one.`,
  appointment_reminder: (p) => `Reminder: ${p.service} with ${p.staff} on ${p.date} at ${p.time} at ${p.branch}.`,
  assignment_new: (p) => `New booking assigned to you: ${p.service} on ${p.date} at ${p.time}.`,
  assignment_removed: (p) => `A booking on ${p.date} at ${p.time} is no longer assigned to you.`,
  replacement_requested: (p) => `A replacement was requested for ${p.service} on ${p.date} at ${p.time}.`,
  replacement_nominee_request: (p) => `Can you cover ${p.service} on ${p.date} at ${p.time}? Please accept or decline in the app.`,
  replacement_accepted: (p) => `The replacement for ${p.date} at ${p.time} has been confirmed.`,
  replacement_rejected: (p) => `The replacement request for ${p.date} at ${p.time} was not completed. The original assignment stands.`,
  manager_approval_required: (p) => `A replacement for ${p.date} at ${p.time} needs your approval.`,
  kpi_reminder: (p) => `Hi ${p.name}, here is your ${p.period} progress: ${p.done} of ${p.target} hours completed, ${p.remaining} to go. You can change these reminders in the app.`,
  customer_otp: (p) => `Your verification code is ${p.code}. It expires in 10 minutes. Do not share it.`,
  human_handoff: (p) => `A customer asked to speak to a person on WhatsApp (${p.customer}). Please open the inbox in the app.`,
  waitlist_available: (p) => `Good news ${p.customer}: a time opened on ${p.date} at ${p.time}. Reply BOOK to reserve it.`,
};
export const renderNotification = (purpose: NotificationPurpose, params: P): string => r[purpose](params);
