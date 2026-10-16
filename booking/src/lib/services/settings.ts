import { z } from "zod";
import type { Tx } from "../db/tx";

/** Typed, defaulted application settings. Stored in application_settings as one JSON document per group. */
export const settingsSchema = z.object({
  booking: z
    .object({
      holdMinutes: z.number().int().min(1).max(60).default(10),
      minNoticeMinutes: z.number().int().min(0).default(120),
      maxAdvanceDays: z.number().int().min(1).max(365).default(60),
      slotStepMinutes: z.number().int().min(5).max(120).default(15),
      /** Customers may cancel/reschedule free of manager involvement until this many hours before the start. */
      changeCutoffHours: z.number().int().min(0).default(24),
      webRequiresApproval: z.boolean().default(false),
      reminderHoursBefore: z.number().int().min(1).default(24),
    })
    .default({
      holdMinutes: 10,
      minNoticeMinutes: 120,
      maxAdvanceDays: 60,
      slotStepMinutes: 15,
      changeCutoffHours: 24,
      webRequiresApproval: false,
      reminderHoursBefore: 24,
    }),
  replacement: z
    .object({
      requireManagerApproval: z.boolean().default(true),
      notifyCustomer: z.boolean().default(true),
      requestExpiryHours: z.number().int().min(1).default(24),
    })
    .default({ requireManagerApproval: true, notifyCustomer: true, requestExpiryHours: 24 }),
  allocation: z
    .object({
      windowDays: z.number().int().min(1).default(14),
      defaultMaxConsecutiveMinutes: z.number().int().min(30).nullable().default(240),
      adjacencyGapMinutes: z.number().int().min(0).default(15),
      respectCustomerPreference: z.boolean().default(true),
    })
    .default({
      windowDays: 14,
      defaultMaxConsecutiveMinutes: 240,
      adjacencyGapMinutes: 15,
      respectCustomerPreference: true,
    }),
  kpi: z
    .object({
      hoursBasis: z.enum(["scheduled", "actual"]).default("scheduled"),
      reminderStart: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .default("09:00"),
      reminderEnd: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .default("20:00"),
    })
    .default({ hoursBasis: "scheduled", reminderStart: "09:00", reminderEnd: "20:00" }),
  whatsapp: z
    .object({ windowHours: z.number().int().default(24), language: z.string().default("en") })
    .default({ windowHours: 24, language: "en" }),
  retention: z
    .object({
      customerInactiveMonths: z.number().int().default(36),
      whatsappMessageDays: z.number().int().default(90),
      webhookEventDays: z.number().int().default(30),
      auditLogMonths: z.number().int().default(84),
      expiredHoldDays: z.number().int().default(7),
    })
    .default({
      customerInactiveMonths: 36,
      whatsappMessageDays: 90,
      webhookEventDays: 30,
      auditLogMonths: 84,
      expiredHoldDays: 7,
    }),
});
export type Settings = z.infer<typeof settingsSchema>;
export type SettingsGroup = keyof Settings;

export async function loadSettings(tx: Tx): Promise<Settings> {
  const rows = await tx.query<{ key: string; value: unknown }>(
    "select key, value from application_settings where organisation_id = $1",
    [tx.ctx.orgId],
  );
  const raw: Record<string, unknown> = {};
  for (const r of rows) raw[r.key] = r.value;
  return settingsSchema.parse(raw);
}

export async function saveSettingsGroup<G extends SettingsGroup>(
  tx: Tx,
  group: G,
  value: Settings[G],
  reason: string,
): Promise<void> {
  const parsed = settingsSchema.shape[group].parse(value);
  await tx.setAuditReason(reason);
  await tx.query(
    `insert into application_settings(organisation_id, key, value, updated_by) values ($1,$2,$3,$4)
     on conflict (organisation_id, key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [tx.ctx.orgId, group, JSON.stringify(parsed), tx.ctx.userId ?? null],
  );
}
