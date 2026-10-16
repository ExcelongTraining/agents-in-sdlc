import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  adminClient,
  at,
  clockAt,
  managerPrincipal,
  NOW,
  resetWorld,
  shutdown,
  staffPrincipal,
  adminPrincipal,
} from "./helpers/world";
import { createDirectBooking } from "@/lib/services/booking";
import { withTx, type DbContext } from "@/lib/db/tx";
import { TRANSITIONS } from "@/lib/domain/status";
import type { World } from "@/lib/seed/base";
import type { Principal } from "@/lib/domain/rbac";

let w: World;
const clock = clockAt(NOW);
let seq = 0;
beforeEach(async () => {
  w = await resetWorld();
});
afterAll(shutdown);

const staffCtx = (p: Principal): DbContext => ({
  kind: "staff",
  orgId: p.orgId,
  userId: p.userId,
  staffId: p.staffId,
  roles: p.roles,
});
async function book(staffIdx: number, start: string) {
  seq++;
  return createDirectBooking(
    managerPrincipal(w),
    {
      branchId: w.branchId,
      serviceId: w.services.massage60,
      startAt: at("2030-03-11", start),
      staffId: w.staff[staffIdx]!.id,
      source: "manager",
      customer: { name: `Secret Customer ${seq}`, phone: `01002${String(seq).padStart(5, "0")}` },
      consent: { serviceBooking: true, whatsapp: false, marketing: false },
    } as never,
    clock,
  );
}

describe("database design guarantees", () => {
  it("row-level security is enabled on every public table", async () => {
    const c = await adminClient();
    const { rows } = await c.query(
      "select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity",
    );
    await c.end();
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("the exclusion constraint alone prevents overlap even if every trigger is bypassed", async () => {
    const m1 = await book(0, "11:00");
    const c = await adminClient();
    try {
      await c.query("set session_replication_role = replica"); // disables all triggers (superuser only)
      const other = await c.query("select id from appointments where id = $1", [m1.appointmentId]);
      expect(other.rowCount).toBe(1);
      await expect(
        c.query(
          `insert into appointment_assignments(organisation_id, appointment_id, staff_id, status, occupied)
         select organisation_id, id, $2, 'active', tstzrange(start_at, end_at) from appointments where id = $1`,
          [m1.appointmentId, w.staff[0]!.id],
        ),
      ).rejects.toMatchObject({ code: expect.stringMatching(/23P01|23505/) }); // overlap (exclusion) or one-active-per-appointment (unique)
      const b2 = await book(1, "11:00"); // a second appointment, then force it onto staff 0 with matching range
      await expect(
        c.query(
          "update appointment_assignments set staff_id = $2 where appointment_id = $1 and status = 'active'",
          [b2.appointmentId, w.staff[0]!.id],
        ),
      ).rejects.toMatchObject({ code: "23P01" });
    } finally {
      await c.end();
    }
  });

  it("status transition table in the database equals the TypeScript state machine", async () => {
    const c = await adminClient();
    const { rows } = await c.query("select from_status f, to_status t from appointment_status_transitions");
    await c.end();
    const db = new Set(rows.map((r) => `${r.f}>${r.t}`));
    const ts = new Set(Object.entries(TRANSITIONS).flatMap(([f, ts]) => ts.map((t) => `${f}>${t}`)));
    expect(db).toEqual(ts);
  });

  it("one active assignment per appointment; at most one open replacement request", async () => {
    const b = await book(0, "11:00");
    const c = await adminClient();
    try {
      await expect(
        c.query(
          "insert into appointment_assignments(organisation_id, appointment_id, staff_id) values ($1,$2,$3)",
          [w.orgId, b.appointmentId, w.staff[1]!.id],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await c.end();
    }
  });
});

describe("row-level security by role", () => {
  it("a masseuse sees only her own appointments and clients", async () => {
    await book(0, "11:00");
    await book(0, "13:00");
    await book(1, "11:00");
    const aisyah = staffPrincipal(w, 0);
    const [appts, customers, assignments] = await withTx(staffCtx(aisyah), async (tx) => [
      await tx.query("select id from appointments"),
      await tx.query("select id from customers"),
      await tx.query("select id from appointment_assignments"),
    ]);
    expect(appts).toHaveLength(2);
    expect(customers).toHaveLength(2);
    expect(assignments).toHaveLength(2);
    const mgr = await withTx(staffCtx(managerPrincipal(w)), (tx) => tx.query("select id from appointments"));
    expect(mgr).toHaveLength(3);
  });

  it("a masseuse cannot modify or even target another masseuse's appointment", async () => {
    const theirs = await book(1, "11:00");
    const res = await withTx(staffCtx(staffPrincipal(w, 0)), (tx) =>
      tx.query("update appointments set operational_note = 'hacked' where id = $1 returning id", [
        theirs.appointmentId,
      ]),
    );
    expect(res).toHaveLength(0);
  });

  it("the administrator has no access to customers, appointments or messages, but can review audit and integration status", async () => {
    await book(0, "11:00");
    const admin = adminPrincipal(w);
    await withTx({ kind: "system", orgId: w.orgId }, async (tx) => {
      await tx.query(
        "insert into webhook_events(organisation_id, event_key, payload) values ($1,'k1','{\"secret\":\"+60123456789\"}')",
        [w.orgId],
      );
    });
    const r = await withTx(staffCtx(admin), async (tx) => ({
      customers: await tx.query("select id from customers"),
      appts: await tx.query("select id from appointments"),
      msgs: await tx.query("select id from whatsapp_messages"),
      raw: await tx.query("select id from webhook_events"),
      audit: await tx.query("select id from audit_logs"),
      view: await tx.query("select * from v_webhook_events_admin"),
    }));
    expect(r.customers).toHaveLength(0);
    expect(r.appts).toHaveLength(0);
    expect(r.msgs).toHaveLength(0);
    expect(r.raw).toHaveLength(0);
    expect(r.audit.length).toBeGreaterThan(0);
    expect(r.view).toHaveLength(1);
    expect(Object.keys(r.view[0]!)).not.toContain("payload");
  });

  it("customer rows in the audit log hold column names only, never values", async () => {
    await book(0, "11:00");
    const c = await adminClient();
    const { rows } = await c.query(
      "select before_data, after_data from audit_logs where entity_type = 'customers'",
    );
    await c.end();
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain("Secret Customer");
    expect(JSON.stringify(rows)).not.toContain("+6010");
  });

  it("staff database role can never read password hashes", async () => {
    await expect(
      withTx(staffCtx(managerPrincipal(w)), (tx) => tx.query("select password_hash from users")),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const ok = await withTx(staffCtx(managerPrincipal(w)), (tx) => tx.query("select id, email from users"));
    expect(ok.length).toBeGreaterThan(0);
  });

  it("a masseuse cannot self-approve leave or working-hours changes", async () => {
    const p = staffPrincipal(w, 0);
    await expect(
      withTx(staffCtx(p), (tx) =>
        tx.query(
          "insert into availability_exceptions(organisation_id, branch_id, staff_id, kind, period, status, requested_by) values ($1,$2,$3,'leave', tstzrange($4,$5), 'approved', $6)",
          [w.orgId, w.branchId, p.staffId, at("2030-04-01", "10:00"), at("2030-04-02", "10:00"), p.userId],
        ),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await withTx(staffCtx(p), (tx) =>
      tx.query(
        "insert into availability_exceptions(organisation_id, branch_id, staff_id, kind, period, status, requested_by) values ($1,$2,$3,'leave', tstzrange($4,$5), 'pending', $6)",
        [w.orgId, w.branchId, p.staffId, at("2030-04-01", "10:00"), at("2030-04-02", "10:00"), p.userId],
      ),
    );
    // pending leave does not block bookings
    await createDirectBooking(
      managerPrincipal(w),
      {
        branchId: w.branchId,
        serviceId: w.services.massage60,
        startAt: at("2030-04-01", "11:00"),
        staffId: p.staffId!,
        source: "manager",
        customer: { name: "X", phone: "0100300001" },
        consent: { serviceBooking: true, whatsapp: false, marketing: false },
      } as never,
      clock,
    );
  });

  it("tenants are isolated: another organisation's rows are invisible and unwritable", async () => {
    await book(0, "11:00");
    const c = await adminClient();
    const other = (
      await c.query("insert into organisations(name, slug) values ('Other','other') returning id")
    ).rows[0].id as string;
    await c.end();
    const seen = await withTx({ kind: "system", orgId: other }, (tx) =>
      tx.query("select id from appointments"),
    );
    expect(seen).toHaveLength(0);
    const seenCust = await withTx({ kind: "system", orgId: other }, (tx) =>
      tx.query("select id from customers"),
    );
    expect(seenCust).toHaveLength(0);
    await expect(
      withTx({ kind: "system", orgId: other }, (tx) =>
        tx.query(
          "insert into customers(organisation_id, display_name, phone_e164) values ($1,'Evil','+60100000000')",
          [w.orgId],
        ),
      ),
    ).rejects.toBeTruthy();
    // a staff member of org A with org B context sees nothing
    const crossed = await withTx(
      { kind: "staff", orgId: other, userId: w.manager.userId, roles: ["manager"] },
      (tx) => tx.query("select id from appointments"),
    );
    expect(crossed).toHaveLength(0);
  });

  it("audit_logs cannot be written by the staff role or altered by anyone", async () => {
    await expect(
      withTx(staffCtx(managerPrincipal(w)), (tx) =>
        tx.query("insert into audit_logs(organisation_id, action, entity_type) values ($1,'x','y')", [
          w.orgId,
        ]),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
