import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, nextWeekday } from "./helpers";

test.describe("customer booking", () => {
  test("books a first-time trial, sees the confirmation, then cancels via the manage link", async ({
    page,
  }) => {
    await page.goto("/book");
    await expect(page.getByRole("heading", { name: "Book an appointment" })).toBeVisible();
    await expectNoHorizontalScroll(page);

    await page.getByLabel("This is my first visit").check();
    await page.getByLabel("A first-time trial").check();
    await expect(page.getByLabel("Service", { exact: true })).toContainText("First-time Trial");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("heading", { name: "Who would you like?" })).toBeVisible();
    await page.getByLabel("Any available masseuse").check();
    await page.getByRole("button", { name: "Show available times" }).click();

    await page.getByLabel("From date").fill(nextWeekday(3)); // a Wednesday at least 3 days ahead
    await page.getByRole("button", { name: "Update times" }).click();
    const firstSlot = page
      .getByRole("list", { name: /Available times/ })
      .getByRole("button")
      .first();
    await expect(firstSlot).toBeVisible();
    await firstSlot.click();

    await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible();
    await expect(page.getByText(/Holding/)).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill("E2E Test Customer");
    await page.getByLabel("Mobile number", { exact: true }).fill("0100000777");
    await expect(page.getByRole("button", { name: "Confirm booking" })).toBeDisabled(); // consent required
    await page.getByLabel(/I have read the privacy notice/).check();
    await page.getByRole("button", { name: "Confirm booking" }).click();

    await expect(page.getByRole("heading", { name: "You're booked" })).toBeVisible();
    await page.getByRole("link", { name: "Change or cancel this booking" }).click();
    await expect(page.getByRole("heading", { name: "Your booking" })).toBeVisible();
    await expect(page.getByText("Confirmed")).toBeVisible();
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Cancel booking" }).click();
    await expect(page.getByText("Your booking has been cancelled.")).toBeVisible();
  });

  test("a made-up manage link reveals nothing", async ({ page }) => {
    await page.goto("/manage/00000000-0000-0000-0000-000000000000.forged");
    await expect(page.getByText(/not valid or has expired/)).toBeVisible();
  });

  for (const path of ["/", "/book", "/privacy", "/login", "/my-bookings"]) {
    test(`accessibility (WCAG 2.2 AA rules) on ${path}`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(
        results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
      ).toEqual([]);
      await expectNoHorizontalScroll(page);
    });
  }
});
