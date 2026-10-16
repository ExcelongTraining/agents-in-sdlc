import { z } from "zod";
import { withTx } from "../db/tx";
import { AppError } from "../errors";
import { requirePermission, type Principal } from "../domain/rbac";
import { env } from "../config/env";
import { ctxFor } from "./booking";
import { staffCtx } from "./schedule";
import { checkPasswordPolicy, hashPassword } from "./password";
import {
  loadSettings,
  saveSettingsGroup,
  settingsSchema,
  type Settings,
  type SettingsGroup,
} from "./settings";

const sys = (p: Principal) => ctxFor(p.orgId, { kind: "staff", principal: p });

// ---- Services ---------------------------------------------------------------------------------------------------
export const serviceInput = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional().nullable(),
  kind: z.enum(["service", "trial", "consultation"]),
  durationMinutes: z.number().int().min(5).max(600),
  bufferBeforeMinutes: z.number().int().min(0).max(120).default(0),
  bufferAfterMinutes: z.number().int().min(0).max(120).default(0),
  priceMyr: z.number().min(0).nullable().optional(),
  showPrice: z.boolean().default(false),
  onlineBookable: z.boolean().default(true),
  countsTowardKpi: z.boolean().default(true),
  requiresRoom: z.boolean().default(false),
  active: z.boolean().default(true),
  staffIds: z.array(z.uuid()).default([]),
});

export async function listServices(p: Principal) {
  return withTx(staffCtx(p), (tx) =>
    tx.query<{
      id: string;
      name: string;
      kind: string;
      duration_minutes: number;
      buffer_before_minutes: number;
      buffer_after_minutes: number;
      price_myr: number | null;
      show_price: boolean;
      online_bookable: boolean;
      counts_toward_kpi: boolean;
      requires_room: boolean;
      active: boolean;
      staff_ids: string[];
      description: string | null;
    }>(
      `select s.*, coalesce((select array_agg(ss.staff_id) from staff_services ss where ss.service_id = s.id), '{}') staff_ids from services s order by s.active desc, s.name`,
    ),
  );
}

export async function saveService(p: Principal, raw: z.input<typeof serviceInput>): Promise<{ id: string }> {
  requirePermission(p, "services.manage");
  const i = serviceInput.parse(raw);
  return withTx(sys(p), async (tx) => {
    let id = i.id;
    const vals = [
      i.name,
      i.description ?? null,
      i.kind,
      i.durationMinutes,
      i.bufferBeforeMinutes,
      i.bufferAfterMinutes,
      i.priceMyr ?? null,
      i.showPrice,
      i.onlineBookable,
      i.countsTowardKpi,
      i.requiresRoom,
      i.active,
      p.userId,
    ];
    if (id) {
      const r = await tx.query(
        "update services set name=$2, description=$3, kind=$4, duration_minutes=$5, buffer_before_minutes=$6, buffer_after_minutes=$7, price_myr=$8, show_price=$9, online_bookable=$10, counts_toward_kpi=$11, requires_room=$12, active=$13, updated_by=$14 where id=$1 returning id",
        [id, ...vals],
      );
      if (!r.length) throw new AppError("NOT_FOUND", "Service not found.");
    } else {
      id = (
        await tx.one<{ id: string }>(
          "insert into services(organisation_id, name, description, kind, duration_minutes, buffer_before_minutes, buffer_after_minutes, price_myr, show_price, online_bookable, counts_toward_kpi, requires_room, active, created_by) values ($14,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id",
          [...vals, p.orgId],
        )
      ).id;
    }
    await tx.query("delete from staff_services where service_id = $1 and staff_id <> all($2)", [
      id,
      i.staffIds,
    ]);
    for (const sid of i.staffIds)
      await tx.query(
        "insert into staff_services(staff_id, service_id, organisation_id) values ($1,$2,$3) on conflict do nothing",
        [sid, id, p.orgId],
      );
    return { id: id as string };
  });
}

// ---- Users and staff -------------------------------------------------------------------------------------------
export const userInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  displayName: z.string().trim().min(2).max(100),
  role: z.enum(["masseuse", "manager", "administrator"]),
  phone: z.string().trim().max(30).optional(),
  password: z.string().max(128),
  branchId: z.uuid().optional(),
});

export async function listUsers(p: Principal) {
  requirePermission(p, "users.manage");
  return withTx(staffCtx(p), (tx) =>
    tx.query<{
      id: string;
      email: string;
      display_name: string;
      status: string;
      roles: string[];
      staff_id: string | null;
      phone_e164: string | null;
      last_login_at: Date | null;
    }>(
      `select u.id, u.email, u.display_name, u.status, u.phone_e164, u.last_login_at,
              coalesce((select array_agg(role_code) from user_roles r where r.user_id = u.id), '{}') roles,
              (select id from staff_profiles sp where sp.user_id = u.id) staff_id
         from users u order by u.display_name`,
    ),
  );
}

export async function createUser(
  p: Principal,
  raw: z.input<typeof userInput>,
): Promise<{ id: string; staffId: string | null }> {
  requirePermission(p, "users.manage");
  const i = userInput.parse(raw);
  const problem = checkPasswordPolicy(i.password, i.email);
  if (problem) throw new AppError("VALIDATION", problem);
  const hash = await hashPassword(i.password);
  return withTx(sys(p), async (tx) => {
    const exists = await tx.maybeOne("select 1 from auth_find_user($1)", [i.email]);
    if (exists) throw new AppError("NOT_ALLOWED", "A user with that e-mail already exists.");
    const branch =
      i.branchId ??
      (
        await tx.one<{ id: string }>(
          "select id from branches where organisation_id = $1 and active order by created_at limit 1",
          [p.orgId],
        )
      ).id;
    const u = await tx.one<{ id: string }>(
      "insert into users(organisation_id, email, display_name, phone_e164, password_hash, must_change_password, created_by) values ($1,$2,$3,$4,$5,true,$6) returning id",
      [p.orgId, i.email, i.displayName, i.phone ?? null, hash, p.userId],
    );
    await tx.query(
      "insert into user_roles(user_id, role_code, organisation_id, branch_id, created_by) values ($1,$2,$3,$4,$5)",
      [u.id, i.role, p.orgId, branch, p.userId],
    );
    let staffId: string | null = null;
    if (i.role === "masseuse") {
      staffId = (
        await tx.one<{ id: string }>(
          "insert into staff_profiles(organisation_id, branch_id, user_id, display_name, phone_e164, created_by) values ($1,$2,$3,$4,$5,$6) returning id",
          [p.orgId, branch, u.id, i.displayName, i.phone ?? null, p.userId],
        )
      ).id;
    }
    return { id: u.id, staffId };
  });
}

export async function setUserStatus(
  p: Principal,
  userId: string,
  status: "active" | "disabled",
): Promise<void> {
  requirePermission(p, "users.manage");
  if (userId === p.userId) throw new AppError("NOT_ALLOWED", "You cannot disable your own account.");
  await withTx(sys(p), async (tx) => {
    const r = await tx.query("update users set status = $2, updated_by = $3 where id = $1 returning id", [
      userId,
      status,
      p.userId,
    ]);
    if (!r.length) throw new AppError("NOT_FOUND", "User not found.");
    if (status === "disabled") await tx.query("delete from sessions where user_id = $1", [userId]);
  });
}

export const staffInput = z.object({
  id: z.uuid(),
  phone: z.string().trim().max(30).nullable().optional(),
  active: z.boolean().optional(),
  canTakeDirectBookings: z.boolean().optional(),
  kpiRemindersEnabled: z.boolean().optional(),
  fairnessWeight: z.number().min(0.1).max(5).optional(),
  maxConsecutiveMinutes: z.number().int().min(30).max(720).nullable().optional(),
});
export async function updateStaffProfile(p: Principal, raw: z.input<typeof staffInput>): Promise<void> {
  const i = staffInput.parse(raw);
  const self = p.staffId === i.id;
  // A masseuse may only switch her own KPI reminders; everything else is manager-controlled.
  if (!(self && Object.keys(i).every((k) => k === "id" || k === "kpiRemindersEnabled")))
    requirePermission(p, "users.manage");
  await withTx(sys(p), async (tx) => {
    const r = await tx.query(
      `update staff_profiles set phone_e164 = case when $2::boolean then $3 else phone_e164 end, active = coalesce($4, active),
              can_take_direct_bookings = coalesce($5, can_take_direct_bookings), kpi_reminders_enabled = coalesce($6, kpi_reminders_enabled),
              fairness_weight = coalesce($7, fairness_weight), max_consecutive_minutes = case when $8::boolean then $9 else max_consecutive_minutes end, updated_by = $10
        where id = $1 returning id`,
      [
        i.id,
        i.phone !== undefined,
        i.phone ?? null,
        i.active ?? null,
        i.canTakeDirectBookings ?? null,
        i.kpiRemindersEnabled ?? null,
        i.fairnessWeight ?? null,
        i.maxConsecutiveMinutes !== undefined,
        i.maxConsecutiveMinutes ?? null,
        p.userId,
      ],
    );
    if (!r.length) throw new AppError("NOT_FOUND", "Staff member not found.");
  });
}

// ---- Settings, templates, audit, integrations ---------------------------------------------------------------
export async function getSettings(p: Principal): Promise<Settings> {
  requirePermission(p, "settings.manage");
  return withTx(staffCtx(p), (tx) => loadSettings(tx));
}
export async function updateSettings(
  p: Principal,
  group: SettingsGroup,
  value: unknown,
  reason: string,
): Promise<void> {
  requirePermission(p, "settings.manage");
  if (!(group in settingsSchema.shape)) throw new AppError("VALIDATION", "Unknown settings group.");
  if (reason.trim().length < 3)
    throw new AppError("VALIDATION", "Please give a short reason for the change.");
  await withTx(sys(p), (tx) => saveSettingsGroup(tx, group, value as never, reason));
}

export async function listTemplates(p: Principal) {
  if (!p.roles.some((r) => r === "manager" || r === "administrator"))
    throw new AppError("FORBIDDEN", "You do not have permission to do that.");
  return withTx(staffCtx(p), (tx) =>
    tx.query<{
      id: string;
      purpose: string;
      name: string;
      language: string;
      category: string;
      status: string;
      provider_template_id: string | null;
      body_preview: string;
    }>(
      "select id, purpose, name, language, category, status, provider_template_id, body_preview from whatsapp_templates order by purpose, language",
    ),
  );
}
export async function updateTemplate(
  p: Principal,
  id: string,
  patch: { status?: string; providerTemplateId?: string | null; name?: string },
): Promise<void> {
  requirePermission(p, "integrations.manage");
  if (
    patch.status &&
    !["draft", "submitted", "approved", "rejected", "paused", "disabled"].includes(patch.status)
  )
    throw new AppError("VALIDATION", "Unknown status.");
  await withTx(sys(p), async (tx) => {
    const r = await tx.query(
      "update whatsapp_templates set status = coalesce($2, status), provider_template_id = coalesce($3, provider_template_id), name = coalesce($4, name), updated_by = $5 where id = $1 returning id",
      [id, patch.status ?? null, patch.providerTemplateId ?? null, patch.name ?? null, p.userId],
    );
    if (!r.length) throw new AppError("NOT_FOUND", "Template not found.");
  });
}

export async function listAudit(
  p: Principal,
  f: { entityType?: string; entityId?: string; limit?: number; before?: number } = {},
) {
  requirePermission(p, "audit.read");
  return withTx(staffCtx(p), (tx) =>
    tx.query<{
      id: number;
      occurred_at: Date;
      actor_user_id: string | null;
      actor_kind: string;
      action: string;
      entity_type: string;
      entity_id: string | null;
      before_data: unknown;
      after_data: unknown;
      reason: string | null;
    }>(
      `select id, occurred_at, actor_user_id, actor_kind, action, entity_type, entity_id, before_data, after_data, reason from audit_logs
        where ($1::text is null or entity_type = $1) and ($2::text is null or entity_id = $2) and ($3::bigint is null or id < $3)
        order by id desc limit $4`,
      [f.entityType ?? null, f.entityId ?? null, f.before ?? null, Math.min(f.limit ?? 100, 500)],
    ),
  );
}

export async function integrationStatus(p: Principal) {
  requirePermission(p, "integrations.manage");
  return withTx(staffCtx(p), async (tx) => {
    const jobs = await tx.query<{ status: string; n: number }>(
      "select status, count(*)::int n from v_notification_jobs_admin group by status",
    );
    const hooks = await tx.query<{ status: string; n: number }>(
      "select status, count(*)::int n from v_webhook_events_admin group by status",
    );
    const templates = await tx.query<{ status: string; n: number }>(
      "select status, count(*)::int n from whatsapp_templates group by status",
    );
    const e = env();
    return {
      provider: e.WHATSAPP_PROVIDER,
      configured: {
        accessToken: !!e.WHATSAPP_ACCESS_TOKEN,
        phoneNumberId: !!e.WHATSAPP_PHONE_NUMBER_ID,
        appSecret: !!e.WHATSAPP_APP_SECRET,
        verifyToken: !!e.WHATSAPP_VERIFY_TOKEN,
      },
      notificationJobs: jobs,
      webhookEvents: hooks,
      templates,
    };
  });
}
