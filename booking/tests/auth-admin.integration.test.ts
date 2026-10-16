import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  adminClient,
  adminPrincipal,
  managerPrincipal,
  resetWorld,
  shutdown,
  staffPrincipal,
} from "./helpers/world";
import { changeOwnPassword, login, logout, resolveSessionToken } from "@/lib/services/auth";
import { checkPasswordPolicy, hashPassword, verifyPassword } from "@/lib/services/password";
import {
  createUser,
  listAudit,
  saveService,
  setUserStatus,
  updateSettings,
  updateStaffProfile,
} from "@/lib/services/admin";
import { settingsSchema } from "@/lib/services/settings";
import { assertSameOrigin } from "@/lib/http/route";
import { resetEnvCacheForTests } from "@/lib/config/env";
import { AppError } from "@/lib/errors";
import type { World } from "@/lib/seed/base";
import type { NextRequest } from "next/server";

let w: World;
beforeEach(async () => {
  w = await resetWorld();
});
afterAll(shutdown);

const q = async (sql: string, params: unknown[] = []) => {
  const c = await adminClient();
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
};
const code = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: unknown) => (e instanceof AppError ? e.code : String(e)),
  );
const PW = "Demo-Password-2026!";

describe("authentication", () => {
  it("logs in with correct credentials, resolves the session, and logs out", async () => {
    const r = await login({ email: "MANAGER@lotus-demo.example", password: PW, ip: "a" });
    expect(r.principal.roles).toEqual(["manager"]);
    expect((await resolveSessionToken(r.token))?.userId).toBe(w.manager.userId);
    expect((await q("select token_hash from sessions"))[0].token_hash).not.toContain(r.token); // only a hash is stored
    await logout(r.token);
    expect(await resolveSessionToken(r.token)).toBeNull();
  });
  it("gives the same error for unknown users and wrong passwords", async () => {
    const a = await login({ email: "nobody@lotus-demo.example", password: PW }).catch((e: AppError) => e);
    const b = await login({ email: "manager@lotus-demo.example", password: "wrong-password-123" }).catch(
      (e: AppError) => e,
    );
    expect((a as AppError).message).toBe((b as AppError).message);
  });
  it("locks the account after repeated failures, even for the right password, and records the attempts", async () => {
    for (let i = 0; i < 5; i++)
      await login({ email: "priya@lotus-demo.example", password: "bad-password-123", ip: `ip${i}` }).catch(
        () => undefined,
      );
    expect(await code(login({ email: "priya@lotus-demo.example", password: PW, ip: "z" }))).toBe(
      "UNAUTHENTICATED",
    );
    expect((await q("select count(*)::int n from audit_logs where action = 'auth.login_failed'"))[0].n).toBe(
      5,
    );
    await q("update users set locked_until = null, failed_login_count = 0 where email like 'priya%'");
    expect(await code(login({ email: "priya@lotus-demo.example", password: PW, ip: "z" }))).toBe("OK");
  });
  it("rate limits login attempts per IP", async () => {
    for (let i = 0; i < 30; i++)
      await login({ email: `x${i}@lotus-demo.example`, password: "whatever-123456", ip: "same-ip" }).catch(
        () => undefined,
      );
    expect(await code(login({ email: "manager@lotus-demo.example", password: PW, ip: "same-ip" }))).toBe(
      "RATE_LIMITED",
    );
  });
  it("disabled users cannot sign in and lose their sessions", async () => {
    const s = await login({ email: "farah@lotus-demo.example", password: PW });
    await setUserStatus(managerPrincipal(w), w.staff[3]!.userId, "disabled");
    expect(await resolveSessionToken(s.token)).toBeNull();
    expect(await code(login({ email: "farah@lotus-demo.example", password: PW }))).toBe("UNAUTHENTICATED");
    expect(await code(setUserStatus(managerPrincipal(w), w.manager.userId, "disabled"))).toBe("NOT_ALLOWED"); // not yourself
  });
  it("passwords are stored as salted scrypt hashes and the policy rejects weak ones", async () => {
    const h = await hashPassword("a long enough password");
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword("a long enough password", h)).toBe(true);
    expect(await verifyPassword("another one entirely", h)).toBe(false);
    expect(await verifyPassword("x", null)).toBe(false);
    for (const weak of ["short", "aaaaaaaaaaaaaaaa", "password1234", "manager-manager-x"])
      expect(checkPasswordPolicy(weak, "manager@x.example")).not.toBeNull();
    expect(checkPasswordPolicy("correct horse battery staple", "manager@x.example")).toBeNull();
  });
  it("changing your own password needs the current one, and signs out other sessions", async () => {
    const keep = await login({ email: "manager@lotus-demo.example", password: PW });
    const other = await login({ email: "manager@lotus-demo.example", password: PW });
    const p = managerPrincipal(w);
    expect(
      await code(changeOwnPassword(p, "not-the-password-1", "brand new long password", keep.token)),
    ).toBe("UNAUTHENTICATED");
    expect(await code(changeOwnPassword(p, PW, "short", keep.token))).toBe("VALIDATION");
    await changeOwnPassword(p, PW, "brand new long password", keep.token);
    expect(await resolveSessionToken(keep.token)).not.toBeNull();
    expect(await resolveSessionToken(other.token)).toBeNull();
    expect(
      await code(login({ email: "manager@lotus-demo.example", password: "brand new long password" })),
    ).toBe("OK");
  });
});

describe("CSRF origin check", () => {
  const req = (method: string, headers: Record<string, string>) =>
    ({ method, headers: new Headers(headers) }) as unknown as NextRequest;
  it("allows same-origin writes and safe methods, blocks cross-site writes", () => {
    process.env.APP_BASE_URL = "https://book.example.my";
    resetEnvCacheForTests();
    expect(() => assertSameOrigin(req("GET", {}))).not.toThrow();
    expect(() => assertSameOrigin(req("POST", { origin: "https://book.example.my" }))).not.toThrow();
    expect(() => assertSameOrigin(req("POST", { "sec-fetch-site": "same-origin" }))).not.toThrow();
    expect(() => assertSameOrigin(req("POST", { origin: "https://evil.example" }))).toThrow(AppError);
    expect(() => assertSameOrigin(req("POST", { "sec-fetch-site": "cross-site" }))).toThrow(AppError);
    process.env.APP_BASE_URL = "http://localhost:3000";
    resetEnvCacheForTests();
  });
});

describe("administration", () => {
  it("manager creates a masseuse with a staff profile; admin and masseuse cannot", async () => {
    const r = await createUser(managerPrincipal(w), {
      email: "New.Person@lotus-demo.example",
      displayName: "New Person",
      role: "masseuse",
      password: "a very long temp password",
      phone: "+60100000999",
    });
    expect(r.staffId).toBeTruthy();
    expect((await q("select must_change_password, email from users where id = $1", [r.id]))[0]).toEqual({
      must_change_password: true,
      email: "new.person@lotus-demo.example",
    });
    expect(
      await code(
        createUser(managerPrincipal(w), {
          email: "new.person@lotus-demo.example",
          displayName: "Dup",
          role: "masseuse",
          password: "a very long temp password",
        }),
      ),
    ).toBe("NOT_ALLOWED");
    expect(
      await code(
        createUser(managerPrincipal(w), {
          email: "weak@lotus-demo.example",
          displayName: "Weak",
          role: "masseuse",
          password: "short",
        }),
      ),
    ).toBe("VALIDATION");
    expect(
      await code(
        createUser(adminPrincipal(w), {
          email: "a@lotus-demo.example",
          displayName: "A",
          role: "manager",
          password: "a very long temp password",
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await code(
        createUser(staffPrincipal(w, 0), {
          email: "b@lotus-demo.example",
          displayName: "B",
          role: "manager",
          password: "a very long temp password",
        }),
      ),
    ).toBe("FORBIDDEN");
  });
  it("service changes are audited and need the services.manage permission", async () => {
    const mgr = managerPrincipal(w);
    const { id } = await saveService(mgr, {
      name: "Hot Stone (75 min)",
      kind: "service",
      durationMinutes: 75,
      bufferAfterMinutes: 15,
      priceMyr: 180,
      showPrice: true,
      staffIds: [w.staff[0]!.id, w.staff[1]!.id],
    });
    expect((await q("select count(*)::int n from staff_services where service_id = $1", [id]))[0].n).toBe(2);
    await saveService(mgr, {
      id,
      name: "Hot Stone (75 min)",
      kind: "service",
      durationMinutes: 90,
      bufferAfterMinutes: 15,
      staffIds: [w.staff[0]!.id],
    });
    expect((await q("select count(*)::int n from staff_services where service_id = $1", [id]))[0].n).toBe(1);
    const audit = await listAudit(mgr, { entityType: "services", entityId: id });
    expect(audit.map((a) => a.action)).toEqual(["services.update", "services.insert"]);
    expect(audit[0]!.after_data).toMatchObject({ duration_minutes: 90 });
    expect(
      await code(
        saveService(staffPrincipal(w, 0), {
          name: "Nope",
          kind: "service",
          durationMinutes: 30,
          staffIds: [],
        }),
      ),
    ).toBe("FORBIDDEN");
  });
  it("settings changes are validated, need a reason, and are audited with it", async () => {
    const mgr = managerPrincipal(w);
    await updateSettings(
      mgr,
      "booking",
      { ...settingsSchema.parse({}).booking, holdMinutes: 5 },
      "Busy season: shorter holds",
    );
    expect((await listAudit(mgr, { entityType: "application_settings" }))[0]!.reason).toBe(
      "Busy season: shorter holds",
    );
    expect(
      await code(
        updateSettings(mgr, "booking", { ...settingsSchema.parse({}).booking, holdMinutes: 500 }, "too long"),
      ),
    ).toBe("VALIDATION");
    expect(await code(updateSettings(mgr, "booking", {}, ""))).toBe("VALIDATION");
    expect(await code(updateSettings(staffPrincipal(w, 0), "booking", {}, "because"))).toBe("FORBIDDEN");
  });
  it("a masseuse may switch only her own KPI reminders; managers control everything else", async () => {
    const a = staffPrincipal(w, 0);
    await updateStaffProfile(a, { id: w.staff[0]!.id, kpiRemindersEnabled: false });
    expect(
      (await q("select kpi_reminders_enabled from staff_profiles where id = $1", [w.staff[0]!.id]))[0]
        .kpi_reminders_enabled,
    ).toBe(false);
    expect(await code(updateStaffProfile(a, { id: w.staff[0]!.id, fairnessWeight: 5 }))).toBe("FORBIDDEN");
    expect(await code(updateStaffProfile(a, { id: w.staff[1]!.id, kpiRemindersEnabled: false }))).toBe(
      "FORBIDDEN",
    );
    await updateStaffProfile(managerPrincipal(w), { id: w.staff[0]!.id, fairnessWeight: 1.5 });
  });
  it("audit log review is limited to manager and administrator", async () => {
    expect((await listAudit(adminPrincipal(w))).length).toBeGreaterThan(0);
    expect(await code(listAudit(staffPrincipal(w, 0)))).toBe("FORBIDDEN");
  });
});

describe("business configuration", () => {
  it("business hours and rooms are managed by the manager and change availability", async () => {
    const { getBusinessHours, saveBusinessHours, saveRoom, listRooms } = await import("@/lib/services/admin");
    const mgr = managerPrincipal(w);
    await saveBusinessHours(mgr, {
      windows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: "10:00", end: "18:00" })),
    });
    expect((await getBusinessHours(mgr)).length).toBe(5);
    expect(
      await code(saveBusinessHours(mgr, { windows: [{ weekday: 1, start: "18:00", end: "10:00" }] })),
    ).toBe("VALIDATION");
    expect(await code(saveBusinessHours(staffPrincipal(w, 0), { windows: [] }))).toBe("FORBIDDEN");
    // Sunday is now closed even for Lakshmi who works Sundays in her own hours
    const { createDirectBooking } = await import("@/lib/services/booking");
    const err = await createDirectBooking(mgr, {
      branchId: w.branchId,
      serviceId: w.services.massage60,
      startAt: new Date("2030-03-10T13:00:00+08:00"),
      staffId: w.staff[4]!.id,
      source: "manager",
      customer: { name: "X", phone: "0100000555" },
      consent: { serviceBooking: true, whatsapp: false, marketing: false },
    } as never).catch((e: AppError) => e);
    expect((err as AppError).code).toBe("OUTSIDE_BUSINESS_HOURS");
    await saveRoom(mgr, { name: "Room 3", active: true });
    expect((await listRooms(mgr)).length).toBe(3);
  });
  it("KPI targets are configurable and history is kept", async () => {
    const { listKpiConfig, setKpiTarget } = await import("@/lib/services/admin");
    const mgr = managerPrincipal(w);
    const cfg = await listKpiConfig(mgr);
    const def = cfg.definitions.find((d) => d.code === "completed_hours_month")!;
    await setKpiTarget(mgr, {
      definitionId: def.id,
      staffId: null,
      targetValue: 100,
      validFrom: "2030-06-01",
    });
    await setKpiTarget(mgr, {
      definitionId: def.id,
      staffId: w.staff[0]!.id,
      targetValue: 80,
      validFrom: "2030-06-01",
    });
    const rows = await q(
      "select staff_id, target_value::float v, valid_from::text f, valid_to::text t from staff_kpi_targets where kpi_definition_id = $1 order by valid_from, staff_id nulls first",
      [def.id],
    );
    expect(rows.find((r) => r.staff_id === null && r.f === "2026-01-01")!.t).toBe("2030-05-31"); // old default closed the day before
    expect(rows.find((r) => r.staff_id === null && r.f === "2030-06-01")!.v).toBe(100);
    const { getKpiDashboard } = await import("@/lib/services/kpi");
    const a = await getKpiDashboard(staffPrincipal(w, 0), { at: new Date("2030-06-15T04:00:00Z") });
    expect(a.lines.find((l) => l.code === "completed_hours_month")!.target).toBe(80); // personal beats default
    const b = await getKpiDashboard(staffPrincipal(w, 1), { at: new Date("2030-06-15T04:00:00Z") });
    expect(b.lines.find((l) => l.code === "completed_hours_month")!.target).toBe(100);
    expect(
      await code(
        setKpiTarget(staffPrincipal(w, 0), {
          definitionId: def.id,
          staffId: null,
          targetValue: 1,
          validFrom: "2030-07-01",
        }),
      ),
    ).toBe("FORBIDDEN");
  });
});
