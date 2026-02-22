import { test, expect } from "@playwright/test";

test.describe("Hill90 Auth Theme — Login Page", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the account page which redirects to login
    await page.goto("/realms/hill90/account");
    // Wait for redirect to login page
    await page.waitForURL(/\/realms\/hill90\/protocol\/openid-connect\//);
  });

  test("loads with correct title", async ({ page }) => {
    await expect(page).toHaveTitle("Sign in to Hill90");
  });

  test("has Hill90 logo via header ::before background-image", async ({
    page,
  }) => {
    const header = page.locator(".pf-v5-c-login__main-header");
    await expect(header).toBeVisible();

    const bgImage = await header.evaluate((el) => {
      return getComputedStyle(el, "::before").backgroundImage;
    });
    expect(bgImage).toContain("data:image/svg+xml");
  });

  test("has branded colors", async ({ page }) => {
    // Dark background on login page
    const loginBg = await page
      .locator(".pf-v5-c-login")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    // #0f1720 = rgb(15, 23, 32)
    expect(loginBg).toBe("rgb(15, 23, 32)");

    // Green primary button
    const buttonBg = await page
      .locator(".pf-v5-c-button.pf-m-primary")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    // #5b9a2f = rgb(91, 154, 47)
    expect(buttonBg).toBe("rgb(91, 154, 47)");
  });

  test("has Hill90 favicon", async ({ page }) => {
    const favicon = page.locator('link[rel="icon"]');
    await expect(favicon).toHaveCount(1);
  });

  test("logo area hover triggers glow", async ({ page }) => {
    const header = page.locator(".pf-v5-c-login__main-header");
    await header.hover();

    const filter = await header.evaluate((el) => {
      return getComputedStyle(el, "::before").filter;
    });
    expect(filter).toContain("drop-shadow");
  });

  test("title hover does NOT trigger logo glow", async ({ page }) => {
    const title = page.locator(
      ".pf-v5-c-login__main-header .pf-v5-c-title"
    );
    await title.hover();

    const filter = await page
      .locator(".pf-v5-c-login__main-header")
      .evaluate((el) => {
        return getComputedStyle(el, "::before").filter;
      });
    expect(filter).not.toContain("drop-shadow");
  });

  test("Forgot Password link is present", async ({ page }) => {
    const forgotLink = page.getByRole("link", { name: /forgot password/i });
    await expect(forgotLink).toBeVisible();
  });

  test("login form has expected fields", async ({ page }) => {
    await expect(page.getByLabel(/username or email/i)).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: /password/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /sign in/i })
    ).toBeVisible();
  });
});

test.describe("Hill90 Auth Theme — Admin Console", () => {
  test("admin console redirects to branded login", async ({ page }) => {
    await page.goto("/admin/hill90/console/");
    // Wait for redirect to login
    await page.waitForURL(/\/realms\/hill90\/protocol\/openid-connect\//);
    await expect(page).toHaveTitle("Sign in to Hill90");
  });
});
