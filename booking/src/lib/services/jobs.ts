import { DateTime } from "luxon";
import { withTx } from "../db/tx";
import { log } from "../log";
import { expireHolds, systemClock, type Clock } from "./booking-shared";
import { enqueueNotification } from "./notifications";
import { processDueNotifications, type OutboxResult } from "./outbox";
import { runRetention } from "./privacy";
import { expireReplacementRequests } from "./replacement";
import { loadSettings } from "./settings";
import { staffKpiLines } from "./kpi";
import { processWebhookEvents } from "./whatsapp-webhook";

/**
 * KPI nudges: at most one per staff member per ISO week, only inside the configured daytime window (branch time zone),
 * only for staff who have not opted out, and only about the person's OWN progress. Wording is neutral: no ranking,
 * no comparison with colleagues, no blame.
 */
export async function scheduleKpiReminders(orgId: string, clock: Clock = systemClock): Promise<number> {
  const now = clock.now();
  return withTx({ kind: "system", orgId, actor: "job" }, async (tx) => {
    const settings = await loadSettings(tx);
    const staff = await tx.query<{ id: string; name: string; tz: string }>(
      `select sp.id, sp.display_name name, b.timezone tz from staff_profiles sp join branches b on b.id = sp.branch_id
        where sp.organisation_id = $1 and sp.active and sp.archived_at is null and sp.kpi_reminders_enabled and sp.phone_e164 is not null`, [orgId]);
    let n = 0;
    for (const s of staff) {
      const local = DateTime.fromJSDate(now, { zone: s.tz });
      const hhmm = local.toFormat("HH:mm");
      if (hhmm < settings.kpi.reminderStart || hhmm >= settings.kpi.reminderEnd) continue;
      if (local.weekday !== 1) continue; // Mondays; the dedupe key below also caps it to once a week
      const lines = await staffKpiLines(tx, s.id, now);
      const line = lines.find((l) => l.period === "month" && l.metric === "completed_service_hours" && l.target);
      if (!line?.progress) continue;
      await enqueueNotification(tx, {
        purpose: "kpi_reminder", recipientKind: "staff", recipientId: s.id,
        params: { name: s.name, period: "month", done: line.progress.actual, target: line.progress.target, remaining: line.progress.remaining },
        dedupeKey: `kpi:${s.id}:${local.toFormat("kkkk-WW")}`,
      });
      n++;
    }
    return n;
  });
}

export interface JobsReport {
  holdsExpired: number;
  replacementsExpired: number;
  webhookEventsProcessed: number;
  notifications: OutboxResult;
  kpiRemindersQueued: number;
  retention?: Record<string, number>;
}

/** One cron tick (every minute or so). Each step is independent and idempotent; a failure in one does not stop the others. */
export async function runScheduledJobs(orgId: string, opts: { clock?: Clock; runRetention?: boolean } = {}): Promise<JobsReport> {
  const clock = opts.clock ?? systemClock;
  const safe = async <T>(name: string, fallback: T, fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (e) { log("error", "job.failed", { job: name, error: (e as Error).message }); return fallback; }
  };
  const holdsExpired = await safe("expireHolds", 0, () => withTx({ kind: "system", orgId, actor: "job" }, (tx) => expireHolds(tx, clock.now())));
  const replacementsExpired = await safe("expireReplacements", 0, () => expireReplacementRequests(orgId, clock));
  const webhookEventsProcessed = await safe("webhookRetry", 0, () => processWebhookEvents(orgId, clock));
  const kpiRemindersQueued = await safe("kpiReminders", 0, () => scheduleKpiReminders(orgId, clock));
  const notifications = await safe("outbox", { sent: 0, retried: 0, dead: 0, skipped: 0 }, () => processDueNotifications(orgId, { clock }));
  const retention = opts.runRetention ? await safe("retention", {}, () => runRetention(orgId, clock)) : undefined;
  return { holdsExpired, replacementsExpired, webhookEventsProcessed, notifications, kpiRemindersQueued, retention };
}
