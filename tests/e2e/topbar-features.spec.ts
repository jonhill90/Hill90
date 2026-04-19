import { test, expect, type Page } from "@playwright/test";

const E2E_USERNAME = process.env.E2E_USERNAME || "jon@hill90.com";
const E2E_PASSWORD = process.env.E2E_PASSWORD || "";

test.skip(!E2E_PASSWORD, "E2E_PASSWORD not set");

async function login(page: Page) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const signIn = page.getByTestId("landing-sign-in");
  if (await signIn.isVisible().catch(() => false)) {
    await signIn.click();
    await page.waitForURL(/auth\.hill90\.com/, { timeout: 15_000 });
  }
  if (page.url().includes("auth.hill90.com")) {
    await page.getByLabel(/username or email/i).fill(E2E_USERNAME);
    await page.getByRole("textbox", { name: /password/i }).fill(E2E_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/hill90\.com/, { timeout: 15_000 });
    await page.waitForLoadState("networkidle");
  }
}

test.describe("TopBar Features", () => {
  test.setTimeout(60_000);

  test("global search bar is visible on desktop", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const search = page.getByTestId("global-search");
    await expect(search).toBeVisible({ timeout: 10_000 });
    await expect(search).toHaveAttribute("placeholder", /search knowledge/i);
  });

  test("search bar navigates to library on enter", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const search = page.getByTestId("global-search");
    await search.fill("test query");
    await search.press("Enter");

    await page.waitForURL(/shared-knowledge.*q=test\+query/, { timeout: 10_000 });
  });

  test("search bar is hidden on mobile", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const search = page.getByTestId("global-search");
    await expect(search).not.toBeVisible();
  });

  test("notifications bell is visible", async ({ page }) => {
    await login(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const bell = page.getByTestId("notifications-bell");
    await expect(bell).toBeVisible({ timeout: 10_000 });
  });

  test("notifications dropdown opens on click", async ({ page }) => {
    await login(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("notifications-bell").click();
    const dropdown = page.getByTestId("notifications-dropdown");
    await expect(dropdown).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Notifications")).toBeVisible();
  });
});
