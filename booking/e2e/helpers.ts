import { expect, type Page } from "@playwright/test";

export const PASSWORD = "Demo-Password-2026!";

export async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/(manager|staff|admin)/);
}

/** ISO date (Kuala Lumpur) of the next given ISO weekday (1=Mon) at least `minDays` ahead. */
export function nextWeekday(isoWeekday: number, minDays = 3): string {
  const kl = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
  kl.setDate(kl.getDate() + minDays);
  while (((kl.getDay() + 6) % 7) + 1 !== isoWeekday) kl.setDate(kl.getDate() + 1);
  return `${kl.getFullYear()}-${String(kl.getMonth() + 1).padStart(2, "0")}-${String(kl.getDate()).padStart(2, "0")}`;
}

export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}
