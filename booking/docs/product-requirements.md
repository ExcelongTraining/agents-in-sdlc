# Product requirements

## Problem

A massage and consultation centre in Malaysia (≥ 5 masseuses, 1 manager) takes bookings by telephone, WhatsApp, walk-in and direct contact with individual masseuses, and keeps the schedule manually. Customers cannot see availability; the manager and masseuses keep separate views; double promises happen; replacements are informal; hours and KPIs cannot be trusted.

## Goal

One authoritative scheduling system (PostgreSQL) used by every channel, preventing double-booking by construction, notifying through WhatsApp, giving each role an appropriate view, supporting controlled replacements, calculating completed hours and KPI progress, and keeping an audit trail.

## Users and roles

| Role                  | Can                                                                                                                                                                                                                                                      | Cannot                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Customer (no account) | check availability, book service / first-time trial / consultation, choose a masseuse or "any", view/reschedule/cancel eligible bookings via link or WhatsApp code, receive WhatsApp confirmation/reminders, join wait-list                              | see anyone else's data; change inside the free-change window                                          |
| Masseuse              | see own schedule and the clients on it (first name, masked phone), progress status (check-in/start/complete/no-show), record a direct booking for herself, request/accept/decline replacement, set hours/breaks/leave **requests**, see own hours & KPIs | see other masseuses' appointments or KPIs, cancel/move appointments, approve anything, override rules |
| Manager               | master schedule, telephone/walk-in bookings, assign/reassign, approve replacements and leave/hours, configure services/hours/rooms/KPI targets/settings, override soft rules with reason, reports, users, privacy requests, WhatsApp hand-offs           | approve a replacement they are part of                                                                |
| Administrator         | integrations status, templates, settings, audit review                                                                                                                                                                                                   | any customer, schedule, message or KPI data                                                           |

## Functional requirements and acceptance criteria (MVP)

IDs map to automated tests (`tests/…`, `e2e/…`) and to `acceptance-checklist.md`.

**Booking and availability**

- B1 Only genuinely free slots are offered (staff hours ∩ business hours, minus bookings with buffers, leave, breaks, closures, rooms; notice/advance limits). _Unit: domain.unit; integration: booking._
- B2 Two customers requesting the same masseuse/time simultaneously → exactly one confirmation. _booking.integration (8-way race ×5, concurrent holds)._
- B3 Overlap with different durations and buffers is rejected; boundaries touching after buffer are allowed. _booking.integration._
- B4 Leave/closure blocks bookings; leave cannot be approved over existing bookings. _booking, services._
- B5 Unqualified staff can never be assigned. _booking, replacement._
- B6 Room conflicts are rejected. _booking._
- B7 Slot holds expire (configurable) and release the slot; an expired hold cannot be confirmed. _booking._
- B8 Duplicate submissions/webhooks are idempotent. _booking, whatsapp._
- B9 If the preferred masseuse is unavailable the customer is offered other times, other masseuses at that time, or the wait-list; never silently reassigned. _e2e, UI._
- B10 "Any available" uses the documented fair-allocation rule (qualification, availability, load, consecutive limit, optional preference, rotation). _domain.unit; booking._
- B11 Manager override of soft rules requires a reason ≥ 5 chars, is stored on the assignment and audited; hard rules cannot be overridden. _booking._
- B12 Reschedule/cancel keep history; failed reschedule leaves the original intact. _booking._
- B13 Time-zone correctness in Asia/Kuala_Lumpur. _booking, domain.unit._

**Channels**

- C1 Customer web booking; C2 manager telephone/walk-in; C3 masseuse direct booking (self only); C4 WhatsApp booking. Source tracked on every appointment. _booking, whatsapp, e2e._
- C5 WhatsApp confirmation to customer and assignment notice to masseuse, queued transactionally. _whatsapp._

**Replacement**

- R1 Request → nominee accepts → manager approves (configurable) → assignment changes only then; original authoritative while pending; history kept; unqualified/unavailable nominee refused (also at acceptance and approval); no self-approval; no double KPI credit. _replacement.integration, e2e._

**Status and KPI**

- S1 Controlled status transitions enforced in code and database. _booking, security._
- K1 KPI hours come from completed appointments; consultation hours separate; replacement hours; cancelled/no-show hours; utilisation; first-time vs returning; configurable targets with explainable formulas. _domain.unit, services._
- K2 Reminders configurable, own-data only, daytime only, opt-out-able, neutral wording. _services._

**Security, privacy, audit**

- P1 Role-based access enforced server-side and by RLS; customers cannot access others' bookings. _security, services, e2e._
- P2 Audit trail of important changes with actor and reason; append-only. _booking, security._
- P3 Consent records, opt-out, export, deletion (anonymisation), retention. _services._

**Experience**

- U1 Mobile-first, installable PWA, WCAG 2.2 AA target with automated axe checks on key pages. _e2e._

## Non-goals (phase two)

Payments, loyalty, packages/memberships, commissions, AI chatbot / multilingual conversational AI, native apps, marketing automation, BI, accounting integrations. Schema extension points are described in `architecture.md`.

## Success measures (suggested)

Zero double-bookings; < 1 minute for the manager to record a phone booking; ≥ 80 % of bookings via web/WhatsApp after three months; no missed assignments (acknowledgement within the hour); KPI reports reconcile with completed appointments.
