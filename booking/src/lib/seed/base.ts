import type { Client } from "pg";
import { hashPassword } from "../services/password";

/**
 * Fictional demo data. No real people, phone numbers or e-mail domains: addresses use the reserved ".example" TLD and
 * phone numbers are placeholders that must never be messaged (use the mock WhatsApp provider).
 */
export interface World {
  orgId: string;
  branchId: string;
  services: { massage60: string; deep90: string; trial30: string; consult20: string; room60: string };
  rooms: string[];
  staff: { id: string; userId: string; name: string }[];
  manager: { userId: string; email: string };
  admin: { userId: string; email: string };
  password: string;
}

const SLUG = "lotus-demo";

export const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? "Demo-Password-2026!";

type Q = Pick<Client, "query">;

export async function seedBase(
  db: Q,
  opts: { passwordHash?: string; templatesApproved?: boolean } = {},
): Promise<World> {
  const hash = opts.passwordHash ?? (await hashPassword(DEMO_PASSWORD));
  const one = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
    (await db.query(sql, params)).rows[0] as T;

  const org = await one<{ id: string }>(
    "insert into organisations(name, slug) values ('Lotus Wellness Centre (demo)', $1) returning id",
    [SLUG],
  );
  const orgId = org.id;
  const branch = await one<{ id: string }>(
    "insert into branches(organisation_id, name, address) values ($1,'Main Branch (demo)','1 Jalan Contoh, Kuala Lumpur') returning id",
    [orgId],
  );
  const branchId = branch.id;

  const mkUser = async (email: string, name: string, role: string) => {
    const phone = role === "manager" ? "+60100000900" : role === "administrator" ? "+60100000901" : null;
    const u = await one<{ id: string }>(
      "insert into users(organisation_id, email, display_name, phone_e164, password_hash) values ($1,$2,$3,$4,$5) returning id",
      [orgId, email, name, phone, hash],
    );
    await db.query(
      "insert into user_roles(user_id, role_code, organisation_id, branch_id) values ($1,$2,$3,$4)",
      [u.id, role, orgId, branchId],
    );
    return u.id;
  };
  const managerId = await mkUser("manager@lotus-demo.example", "Demo Manager", "manager");
  const adminId = await mkUser("admin@lotus-demo.example", "Demo Administrator", "administrator");

  const names = ["Aisyah", "Mei Ling", "Priya", "Farah", "Lakshmi"];
  const staff: World["staff"] = [];
  for (const [i, name] of names.entries()) {
    const userId = await mkUser(
      `${name.toLowerCase().replace(/\s/g, "")}@lotus-demo.example`,
      name,
      "masseuse",
    );
    const sp = await one<{ id: string }>(
      "insert into staff_profiles(organisation_id, branch_id, user_id, display_name, phone_e164) values ($1,$2,$3,$4,$5) returning id",
      [orgId, branchId, userId, name, `+6010000010${i}`],
    );
    staff.push({ id: sp.id, userId, name });
  }

  const svc = async (
    name: string,
    kind: string,
    dur: number,
    bufAfter: number,
    price: number | null,
    kpi: boolean,
    room = false,
    desc = "",
  ) =>
    (
      await one<{ id: string }>(
        `insert into services(organisation_id, name, description, kind, duration_minutes, buffer_after_minutes, price_myr, show_price, counts_toward_kpi, requires_room)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [orgId, name, desc, kind, dur, bufAfter, price, price !== null, kpi, room],
      )
    ).id;
  const services = {
    massage60: await svc(
      "Traditional Massage (60 min)",
      "service",
      60,
      10,
      120,
      true,
      false,
      "Full-body traditional massage.",
    ),
    deep90: await svc(
      "Deep Tissue Massage (90 min)",
      "service",
      90,
      10,
      170,
      true,
      false,
      "Firm pressure focused on tension areas.",
    ),
    trial30: await svc(
      "First-time Trial (30 min)",
      "trial",
      30,
      10,
      49,
      true,
      false,
      "A short introductory session for new customers.",
    ),
    consult20: await svc(
      "Consultation (20 min)",
      "consultation",
      20,
      5,
      null,
      false,
      false,
      "Talk through your needs with a therapist. No treatment.",
    ),
    room60: await svc(
      "Private Room Therapy (60 min)",
      "service",
      60,
      15,
      150,
      true,
      true,
      "Treatment in a private room.",
    ),
  };
  const quals: [string, number[]][] = [
    [services.massage60, [0, 1, 2, 3, 4]],
    [services.deep90, [0, 1, 2]],
    [services.trial30, [0, 1, 2, 3, 4]],
    [services.consult20, [0, 1, 2, 3, 4]],
    [services.room60, [0, 1, 3]],
  ];
  for (const [sid, idxs] of quals)
    for (const i of idxs)
      await db.query("insert into staff_services(staff_id, service_id, organisation_id) values ($1,$2,$3)", [
        staff[i]!.id,
        sid,
        orgId,
      ]);

  const rooms: string[] = [];
  for (const n of ["Room 1", "Room 2"])
    rooms.push(
      (
        await one<{ id: string }>(
          "insert into rooms(organisation_id, branch_id, name) values ($1,$2,$3) returning id",
          [orgId, branchId, n],
        )
      ).id,
    );

  // Business hours 09:00-21:00 every day; staff 10:00-19:00 Mon-Sat except Lakshmi 13:00-21:00 Tue-Sun.
  for (let wd = 1; wd <= 7; wd++)
    await db.query(
      "insert into business_hours(organisation_id, branch_id, weekday, open_time, close_time) values ($1,$2,$3,'09:00','21:00')",
      [orgId, branchId, wd],
    );
  for (const [i, s] of staff.entries()) {
    for (let wd = 1; wd <= 7; wd++) {
      const [from, to, days] =
        i === 4 ? ["13:00", "21:00", [2, 3, 4, 5, 6, 7]] : ["10:00", "19:00", [1, 2, 3, 4, 5, 6]];
      if ((days as number[]).includes(wd))
        await db.query(
          "insert into staff_working_hours(organisation_id, staff_id, weekday, start_time, end_time) values ($1,$2,$3,$4,$5)",
          [orgId, s.id, wd, from, to],
        );
    }
  }

  const settings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings))
    await db.query("insert into application_settings(organisation_id, key, value) values ($1,$2,$3)", [
      orgId,
      k,
      JSON.stringify(v),
    ]);

  const tplStatus = opts.templatesApproved === false ? "draft" : "approved";
  const templates: [string, string, string, string[]][] = [
    [
      "booking_request_received",
      "We received your request for {{service}} on {{date}} at {{time}}. We will confirm shortly.",
      "utility",
      ["customer", "service", "date", "time"],
    ],
    [
      "slot_held",
      "We are holding {{date}} {{time}} for you for a few minutes. Please complete your booking.",
      "utility",
      ["customer", "date", "time"],
    ],
    [
      "booking_confirmed",
      "Hi {{customer}}, your {{service}} with {{staff}} is confirmed for {{date}} at {{time}} at {{branch}}.",
      "utility",
      ["customer", "service", "staff", "date", "time", "branch"],
    ],
    [
      "booking_changed",
      "Hi {{customer}}, your booking has changed: {{service}} with {{staff}} on {{date}} at {{time}}.",
      "utility",
      ["customer", "service", "staff", "date", "time"],
    ],
    [
      "booking_cancelled",
      "Hi {{customer}}, your booking for {{date}} at {{time}} has been cancelled.",
      "utility",
      ["customer", "date", "time"],
    ],
    [
      "appointment_reminder",
      "Reminder: {{service}} with {{staff}} on {{date}} at {{time}} at {{branch}}.",
      "utility",
      ["customer", "service", "staff", "date", "time", "branch"],
    ],
    [
      "assignment_new",
      "New booking: {{service}} on {{date}} at {{time}}.",
      "utility",
      ["service", "date", "time"],
    ],
    [
      "assignment_removed",
      "A booking on {{date}} at {{time}} is no longer assigned to you.",
      "utility",
      ["date", "time"],
    ],
    [
      "replacement_requested",
      "Replacement requested for {{service}} on {{date}} at {{time}}.",
      "utility",
      ["service", "date", "time"],
    ],
    [
      "replacement_nominee_request",
      "Can you cover {{service}} on {{date}} at {{time}}? Open the app to accept or decline.",
      "utility",
      ["service", "date", "time"],
    ],
    [
      "replacement_accepted",
      "Replacement for {{date}} at {{time}} was accepted.",
      "utility",
      ["date", "time"],
    ],
    [
      "replacement_rejected",
      "Replacement for {{date}} at {{time}} was not approved.",
      "utility",
      ["date", "time"],
    ],
    [
      "manager_approval_required",
      "A replacement for {{date}} at {{time}} needs your approval.",
      "utility",
      ["date", "time"],
    ],
    [
      "kpi_reminder",
      "Hi {{name}}, your progress this {{period}}: {{done}} of {{target}} hours. Remaining: {{remaining}}.",
      "utility",
      ["name", "period", "done", "target", "remaining"],
    ],
    [
      "customer_otp",
      "Your verification code is {{code}}. It expires in 10 minutes.",
      "authentication",
      ["code"],
    ],
    [
      "human_handoff",
      "A customer asked to speak to a person on WhatsApp ({{customer}}). Please open the inbox in the app.",
      "utility",
      ["customer"],
    ],
    [
      "waitlist_available",
      "Good news {{customer}}: a time opened on {{date}} at {{time}}. Reply to book it.",
      "utility",
      ["customer", "date", "time"],
    ],
  ];
  for (const [purpose, body, category, params] of templates) {
    await db.query(
      "insert into whatsapp_templates(organisation_id, purpose, name, language, category, status, body_preview, param_names) values ($1,$2,$3,'en',$4,$5,$6,$7)",
      [orgId, purpose, `${purpose}_v1`, category, tplStatus, body, params],
    );
  }

  const kpis: [string, string, string, string, number | null][] = [
    ["completed_hours_month", "Completed service hours (month)", "completed_service_hours", "month", 120],
    ["completed_hours_week", "Completed service hours (week)", "completed_service_hours", "week", 30],
    ["scheduled_hours_week", "Scheduled service hours (week)", "scheduled_service_hours", "week", null],
    ["consultation_hours_month", "Consultation hours (month)", "consultation_hours", "month", null],
    ["utilisation_month", "Utilisation (month)", "utilisation_pct", "month", null],
    ["appointments_month", "Completed appointments (month)", "completed_appointments", "month", null],
    ["first_time_month", "First-time clients (month)", "first_time_clients", "month", null],
    ["returning_month", "Returning clients (month)", "returning_clients", "month", null],
    ["replacement_hours_month", "Replacement hours (month)", "replacement_hours", "month", null],
    ["cancelled_hours_month", "Cancelled hours (month)", "cancelled_hours", "month", null],
    ["no_show_hours_month", "No-show hours (month)", "no_show_hours", "month", null],
  ];
  for (const [code, name, metric, period, target] of kpis) {
    const k = await one<{ id: string }>(
      "insert into kpi_definitions(organisation_id, code, name, metric, period) values ($1,$2,$3,$4,$5) returning id",
      [orgId, code, name, metric, period],
    );
    if (target)
      await db.query(
        "insert into staff_kpi_targets(organisation_id, kpi_definition_id, staff_id, target_value, valid_from) values ($1,$2,null,$3,'2026-01-01')",
        [orgId, k.id, target],
      );
  }

  return {
    orgId,
    branchId,
    services,
    rooms,
    staff,
    manager: { userId: managerId, email: "manager@lotus-demo.example" },
    admin: { userId: adminId, email: "admin@lotus-demo.example" },
    password: DEMO_PASSWORD,
  };
}
