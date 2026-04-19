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

test.describe("MCP Servers Page", () => {
  test.setTimeout(60_000);

  test("renders MCP servers page", async ({ page }) => {
    await login(page);
    await page.goto("/harness/mcp-servers");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("MCP Servers")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Add Server")).toBeVisible();
  });

  test("can open create form with transport options", async ({ page }) => {
    await login(page);
    await page.goto("/harness/mcp-servers");
    await page.waitForLoadState("networkidle");

    await page.getByText("Add Server").click();
    await expect(page.getByText("Transport")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("stdio (local process)")).toBeVisible();
  });
});
