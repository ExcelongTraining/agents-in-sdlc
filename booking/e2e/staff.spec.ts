import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { login, nextWeekday } from "./helpers";

const manager = "manager@lotus-demo.example";
const base = `http://localhost:${process.env.E2E_PORT ?? 3100}`;

async function bookViaForm(
  page: Page,
  opts: { staffLabel: string; customer: string; phone: string; time: string },
) {
  await page.goto("/manager/new");
  await page.getByLabel("Service").selectOption({ label: "Traditional Massage (60 min) (60 min)" });
  await page.getByLabel("Masseuse").selectOption({ label: opts.staffLabel });
  await page.getByLabel("Date").fill(nextWeekday(3, 4));
  await page.getByLabel("Or a custom start time").fill(`${nextWeekday(3, 4)}T${opts.time}`);
  await page.getByLabel("Name", { exact: true }).fill(opts.customer);
  await page.getByLabel("Mobile number", { exact: true }).fill(opts.phone);
  await page.getByLabel(/I have told the customer/).check();
  await page.getByRole("button", { name: "Create booking" }).click();
  await expect(page.getByText(/^Booked Traditional Massage/)).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("manager records a telephone booking; the same slot cannot be booked twice", async ({ page }) => {
  await login(page, manager);
  await bookViaForm(page, {
    staffLabel: "Aisyah",
    customer: "Alina Tester",
    phone: "0100000801",
    time: "11:00",
  });
  await page.getByLabel("Name", { exact: true }).fill("Chloe Tester");
  await page.getByLabel("Mobile number", { exact: true }).fill("0100000802");
  await page.getByLabel("Or a custom start time").fill(`${nextWeekday(3, 4)}T11:00`);
  await page.getByLabel(/I have told the customer/).check();
  await page.getByRole("button", { name: "Create booking" }).click();
  await expect(page.locator(".alert-error")).toContainText(/just been taken/);
  await bookViaForm(page, {
    staffLabel: "Mei Ling",
    customer: "Benita Tester",
    phone: "0100000803",
    time: "11:00",
  });
});

test("a masseuse sees only her own appointments", async ({ page }) => {
  await login(page, "aisyah@lotus-demo.example");
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(page.getByText("Alina").first()).toBeVisible();
  await expect(page.getByText("Benita")).toHaveCount(0);
  await expect(page.getByText("New").first()).toBeVisible();
  await expect(page.getByText(/\+60•+/).first()).toBeVisible(); // masseuses see first names only and masked phone numbers
  await page.goto("/manager");
  await expect(page).toHaveURL(/\/staff/);
  expect((await page.request.get("/api/admin/users")).status()).toBe(403);
});

test("replacement: request → nominee accepts → manager approves → assignment moves", async ({ browser }) => {
  const a = await (await browser.newContext({ baseURL: base })).newPage();
  await login(a, "aisyah@lotus-demo.example");
  await a.getByRole("button", { name: "Request replacement" }).first().click();
  await a.getByLabel("Reason").fill("Family matter");
  await a.getByLabel("Nominate a colleague (optional)").selectOption({ label: "Farah" });
  await a.getByRole("button", { name: "Send request" }).click();
  await expect(a.getByText(/A replacement is pending/)).toBeVisible();

  const f = await (await browser.newContext({ baseURL: base })).newPage();
  await login(f, "farah@lotus-demo.example");
  await f.goto("/staff/replacements");
  await expect(f.getByText(/Can you cover/)).toBeVisible();
  await f.getByRole("button", { name: "Accept" }).click();
  await expect(f.getByText(/Waiting for the manager/)).toBeVisible();

  const m = await (await browser.newContext({ baseURL: base })).newPage();
  await login(m, manager);
  await m.goto("/manager/replacements");
  await expect(m.getByText(/awaiting manager approval/)).toBeVisible();
  await m.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(m.getByText("completed").first()).toBeVisible();

  await f.goto("/staff");
  await expect(f.getByText("Alina").first()).toBeVisible();
  await a.reload();
  await expect(a.getByText("Alina")).toHaveCount(0);
});

test("role boundaries: administrator cannot see customers; anonymous users are sent to sign in", async ({
  page,
  browser,
}) => {
  await login(page, "admin@lotus-demo.example");
  await expect(page.getByRole("heading", { name: "Integrations" })).toBeVisible();
  expect((await page.request.get("/api/admin/customers?q=Alina")).status()).toBe(403);
  expect(
    (await page.request.get("/api/schedule?from=2030-01-01T00:00:00Z&to=2030-02-01T00:00:00Z")).status(),
  ).toBe(403);
  const anon = await (await browser.newContext({ baseURL: base })).newPage();
  await anon.goto("/manager");
  await expect(anon).toHaveURL(/\/login/);
});

test("manager pages pass automated accessibility checks", async ({ page }) => {
  await login(page, manager);
  for (const path of [
    "/manager",
    "/manager/new",
    "/manager/replacements",
    "/manager/availability",
    "/manager/reports",
    "/manager/services",
    "/manager/team",
    "/manager/settings",
  ]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const r = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      r.violations.map((v) => `${path} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    ).toEqual([]);
  }
});

test("the master schedule renders on a phone", async ({ page }) => {
  await login(page, manager);
  await page.goto("/manager/calendar");
  await expect(page.locator(".fc")).toBeVisible();
  await expect(page.getByRole("button", { name: /day/i }).first()).toBeVisible();
});
