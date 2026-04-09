import { test, expect, type Page } from "@playwright/test";

/**
 * Secrets page E2E tests.
 *
 * Requires env vars:
 *   E2E_USERNAME — Keycloak admin user (default: jon)
 *   E2E_PASSWORD — Keycloak user password
 *
 * Tests run against the live platform (hill90.com) and require
 * admin role to access the secrets page.
 */

const E2E_USERNAME = process.env.E2E_USERNAME || "jon";
const E2E_PASSWORD = process.env.E2E_PASSWORD || "";

test.skip(!E2E_PASSWORD, "E2E_PASSWORD not set — skipping secrets E2E tests");

/** Log in through Keycloak and return to the app. */
async function login(page: Page) {
  await page.goto("/");

  if (page.url().includes("auth.hill90.com")) {
    await page.getByLabel(/username or email/i).fill(E2E_USERNAME);
    await page.getByRole("textbox", { name: /password/i }).fill(E2E_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/hill90\.com/, { timeout: 15_000 });
  }
}

test.describe("Secrets Page", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("secrets page loads and shows vault paths", async ({ page }) => {
    await page.goto("/harness/secrets");
    await page.waitForLoadState("networkidle");

    // Should see the Secrets heading
    await expect(
      page.getByRole("heading", { name: /secrets/i })
    ).toBeVisible({ timeout: 10_000 });

    // Should see a table with vault paths — look for <code> elements
    // containing path separators (secret/ or similar)
    const pathCells = page.locator("table code");
    await expect(pathCells.first()).toBeVisible({ timeout: 10_000 });

    // Should have at least one vault path listed
    const pathCount = await pathCells.count();
    expect(pathCount).toBeGreaterThan(0);
  });

  test("expand vault path to show keys", async ({ page }) => {
    await page.goto("/harness/secrets");
    await page.waitForLoadState("networkidle");

    // Wait for paths to load
    const firstPathRow = page.locator("table tbody tr").first();
    await expect(firstPathRow).toBeVisible({ timeout: 10_000 });

    // Click the first path row to expand it
    await firstPathRow.click();

    // After expansion, should see key rows — look for KeyRound icon (svg)
    // or additional rows with smaller code elements (key names)
    const expandedKeyRows = page.locator("table tbody tr").filter({
      has: page.locator("code"),
    });

    // Should now have more rows than before (path rows + key rows)
    await expect(expandedKeyRows.nth(1)).toBeVisible({ timeout: 5_000 });
  });

  test("Add Secret button shows form", async ({ page }) => {
    await page.goto("/harness/secrets");
    await page.waitForLoadState("networkidle");

    // Find and click the Add Secret button
    const addBtn = page.getByRole("button", { name: /add secret/i });
    await expect(addBtn).toBeVisible({ timeout: 10_000 });
    await addBtn.click();

    // Form should appear with path, key, and value fields
    await expect(
      page.getByPlaceholder(/secret\/shared/i)
    ).toBeVisible({ timeout: 5_000 });

    await expect(
      page.getByPlaceholder(/DB_PASSWORD/i)
    ).toBeVisible();

    await expect(
      page.getByPlaceholder(/enter secret value/i)
    ).toBeVisible();

    // Cancel button should be visible
    const cancelBtn = page.getByRole("button", { name: /cancel/i });
    await expect(cancelBtn).toBeVisible();

    // Click cancel to close form
    await cancelBtn.click();

    // Form fields should no longer be visible
    await expect(
      page.getByPlaceholder(/secret\/shared/i)
    ).not.toBeVisible();
  });
});
