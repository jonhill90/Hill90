import { test, expect } from "@playwright/test";

test.describe("Hill90 Smoke Tests (no auth required)", () => {
  test("homepage loads with Hill90 title", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle("Hill90");
  });

  test("homepage shows Hill90 logo", async ({ page }) => {
    await page.goto("/");
    const logo = page.getByRole("img", { name: /hill90 logo/i });
    await expect(logo).toBeVisible({ timeout: 10_000 });
  });

  test("homepage shows sign in or dashboard", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Either landing page (unauthenticated) or dashboard (authenticated)
    const signIn = page.getByTestId("landing-sign-in");
    const dashboard = page.getByText("Running Agents");
    const visible = await signIn.isVisible().catch(() => false) || await dashboard.isVisible().catch(() => false);
    expect(visible).toBe(true);
  });

  test("API health endpoint responds", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.status).toBe("healthy");
  });

  test("auth login page accessible", async ({ page }) => {
    await page.goto("/api/auth/signin");
    await expect(page.getByText("Sign in with Keycloak")).toBeVisible({ timeout: 10_000 });
  });
});
