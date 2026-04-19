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

test.describe("Library & Knowledge", () => {
  test.setTimeout(60_000);

  test("library page shows collections with source counts", async ({ page }) => {
    await login(page);
    await page.goto("/harness/shared-knowledge");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Library")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Hill90 Platform")).toBeVisible();
    await expect(page.getByText(/\d+ sources/)).toBeVisible();
  });

  test("library search returns results", async ({ page }) => {
    await login(page);
    await page.goto("/harness/shared-knowledge");
    await page.waitForLoadState("networkidle");

    // Click Search tab
    await page.getByRole("button", { name: "Search" }).click();
    await page.getByPlaceholder("Search shared knowledge...").fill("deployment");
    await page.getByRole("button", { name: "Search" }).nth(1).click();

    await expect(page.getByText(/\d+ results/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Deployment Runbook")).toBeVisible();
  });

  test("library has Graph tab", async ({ page }) => {
    await login(page);
    await page.goto("/harness/shared-knowledge");
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "Graph" }).click();
    await expect(page.getByText(/\d+ collections/)).toBeVisible({ timeout: 10_000 });
  });

  test("knowledge page shows agent entries", async ({ page }) => {
    await login(page);
    await page.goto("/harness/knowledge");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Agent Knowledge")).toBeVisible({ timeout: 10_000 });
    // Should show Browser Test v2 with entries
    await expect(page.getByText("Browser Test v2")).toBeVisible({ timeout: 10_000 });
  });
});
