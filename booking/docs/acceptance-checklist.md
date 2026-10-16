# Manual acceptance test checklist

Run against a staging deployment (mock WhatsApp first, then a sandbox number). Use fictional customers. Tick and date each line; record failures as issues.

Login: password from your seed. Use a phone for the customer steps (Chrome/Safari) and a laptop for the manager.

## A. Customer web booking

- [ ] `/book` loads on a phone with no horizontal scrolling; keyboard-only use works; focus is visible.
- [ ] Choose “first visit” → trial → any masseuse → a date 3+ days ahead → times appear for that day.
- [ ] Pick a time: a hold banner with a countdown appears; “Confirm booking” is disabled until the privacy checkbox is ticked.
- [ ] Confirm. Confirmation page shows service, masseuse, date/time; the “Change or cancel” link opens the booking.
- [ ] (WhatsApp ON) customer receives the confirmation; masseuse receives the assignment message; manager sees the booking on the dashboard/calendar immediately.
- [ ] Open the same slot in a second browser during the hold: it is not offered / is refused with a clear message.
- [ ] Let a hold expire (10 min): confirming fails with “expired”; the time is bookable again.
- [ ] Choose a named masseuse who is fully booked: you are offered other masseuses/“look a week later”/wait-list, never an automatic switch.
- [ ] Reschedule through the link to another time (same masseuse): new time shown; old time free again; a “changed” message is sent.
- [ ] Cancel through the link; booking disappears; slot is free; cancellation message sent.
- [ ] Inside 24 h of the start: change/cancel is refused with the contact-us message.
- [ ] Edit the link (change a character): “not valid or has expired”, no data shown.
- [ ] `/my-bookings`: enter an unknown number → same generic reply; enter a real number → code on WhatsApp → bookings listed; wrong code ×5 locks the code.

## B. Manager

- [ ] Sign in; dashboard shows today, alerts, staff status.
- [ ] New booking by telephone for masseuse A at a free time → success; same time again → “just been taken”.
- [ ] Walk-in starting now using the custom time → success.
- [ ] “Any available (fair allocation)” twice at the same time → two different masseuses; third/fourth continue until none left, then refused.
- [ ] Booking outside a masseuse's hours without override → refused; with override + reason → accepted; open Audit log: the override and reason are recorded. Overriding double-booking/leave is not possible.
- [ ] Master schedule: day/week/month views; drag a confirmed booking to a free time → moves; drag onto a busy time → snaps back with an explanation.
- [ ] Reassign a booking to another qualified masseuse (reason required); the customer is notified; unqualified masseuses are refused.
- [ ] Add leave for a masseuse over an existing booking → refused; after moving the booking → accepted; that masseuse is no longer offered in that period.
- [ ] Add a branch closure → nobody is offered that period.
- [ ] Change business hours, add a room, edit a service (duration/buffer/qualified staff) → availability reflects it.
- [ ] Set a KPI target; reports show cancellation/no-show rates, bookings by source, workload share.
- [ ] Team: create a masseuse (temporary password) → first login forces a password change; disable a user → their session ends.
- [ ] Settings: change hold minutes; the change appears in the Audit log with the reason.

## C. Masseuse

- [ ] Sign in: only her own appointments; names show first name only; phone masked; “New” badge and banner for new assignments; “Mark as seen” clears them.
- [ ] Try `/manager` → redirected to `/staff`.
- [ ] Check in → Start → Complete on an appointment whose time has begun; Complete before start is refused.
- [ ] “Record a booking”: for herself, same-time clash with the manager's booking is refused.
- [ ] Request time off → shows pending; manager approves → effective.
- [ ] Propose new weekly hours → pending; current hours unchanged until approval.
- [ ] Request replacement with a colleague → appointment shows “replacement pending”; she remains assigned.
- [ ] Colleague accepts → waits for the manager; manager approves → appointment moves; the original masseuse's list no longer shows it; both are notified.
- [ ] Replacement declined/expired → appointment returns to normal.
- [ ] “My hours & KPIs”: completed hours match her completed appointments; formulas visible; no colleagues' data.
- [ ] Turn off the weekly KPI reminder → none is sent.

## D. Replacement edge cases

- [ ] Nominee given another booking at the same time before accepting → acceptance refused.
- [ ] Nominee gets approved leave after accepting, before approval → approval results in “failed”; original stays.
- [ ] Manager who is also the requester/nominee cannot approve their own request.
- [ ] Unqualified nominee refused at request time.
- [ ] KPI: after completion only the replacement is credited (reports show replacement hours).

## E. WhatsApp (sandbox)

- [ ] Verify-token handshake succeeds in Meta's console; a tampered signature is rejected (403).
- [ ] Inbound “Hi” → menu; full booking via buttons/lists ends with a confirmed booking visible to the manager.
- [ ] Send the same inbound event twice (replay from the console): one reply only.
- [ ] STOP → no further notifications; BOOK re-enables.
- [ ] “Talk to a person” → manager sees it in WhatsApp inbox and on the dashboard; reply works within 24 h; outside the window the UI says to phone.
- [ ] Kill the access token: jobs retry, then dead-letter; dashboard alert shows.
- [ ] Template statuses set to approved are used; draft templates fall back to free text only inside the 24 h window.

## F. Administrator

- [ ] Sees integrations status, templates, audit; cannot open customers, schedule or KPI (`/manager` redirects, API calls return 403).

## G. Privacy

- [ ] Manager → Privacy: export a customer → JSON with consents/appointments/messages; request logged.
- [ ] Delete (anonymise) a customer with no upcoming bookings → name/phone gone, bookings remain; with upcoming bookings → refused.
- [ ] Privacy notice reachable from booking and WhatsApp consent step; marketing consent is a separate, unticked box.
- [ ] No full phone numbers appear in application logs (search the host log for a test number).

## H. Resilience and security spot checks

- [ ] Wrong password ×5 locks the account for 15 minutes; manager can reset it.
- [ ] A POST to any `/api/*` route from another origin is refused.
- [ ] Offline: the PWA shows the offline page; no schedule data is shown from cache.
- [ ] Backup restored into a scratch database passes the smoke queries in `backup-restore.md`.
