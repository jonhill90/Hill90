import { test, expect, type Page } from "@playwright/test";

/**
 * Chat flow E2E tests.
 *
 * Requires env vars:
 *   E2E_USERNAME — Keycloak test user (default: testuser01)
 *   E2E_PASSWORD — Keycloak test user password
 *
 * These tests run against the live platform (hill90.com) and require
 * at least one agent in "running" state.
 */

const E2E_USERNAME = process.env.E2E_USERNAME || "testuser01";
const E2E_PASSWORD = process.env.E2E_PASSWORD || "";

test.skip(!E2E_PASSWORD, "E2E_PASSWORD not set — skipping chat E2E tests");

/** Log in through Keycloak and return to the app. */
async function login(page: Page) {
  await page.goto("/");

  // If redirected to Keycloak login, fill credentials
  if (page.url().includes("auth.hill90.com")) {
    await page.getByLabel(/username or email/i).fill(E2E_USERNAME);
    await page.getByRole("textbox", { name: /password/i }).fill(E2E_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    // Wait for redirect back to app
    await page.waitForURL(/hill90\.com/, { timeout: 15_000 });
  }
}

test.describe("Chat Flow", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("login succeeds and shows authenticated UI", async ({ page }) => {
    // Should be on the app, not the login page
    await expect(page).not.toHaveURL(/auth\.hill90\.com/);
    // Sidebar or nav should be visible
    await expect(page.locator("nav, aside").first()).toBeVisible();
  });

  test("navigate to agents page", async ({ page }) => {
    await page.goto("/agents");
    await page.waitForLoadState("networkidle");

    // Should see agents heading or agent cards
    await expect(
      page.getByRole("heading", { name: /agents/i }).or(page.locator("[data-testid]").first())
    ).toBeVisible({ timeout: 10_000 });
  });

  test("navigate to chat page", async ({ page }) => {
    await page.goto("/chat");
    await page.waitForLoadState("networkidle");

    // Should see "New Chat" button or thread list
    await expect(
      page
        .getByRole("button", { name: /new chat/i })
        .or(page.getByText(/no conversations yet/i))
    ).toBeVisible({ timeout: 10_000 });
  });

  test("create thread and send message", async ({ page }) => {
    await page.goto("/chat");
    await page.waitForLoadState("networkidle");

    // Click "New Chat"
    const newChatBtn = page.getByRole("button", { name: /new chat/i });
    await expect(newChatBtn).toBeVisible({ timeout: 10_000 });
    await newChatBtn.click();

    // Wait for dialog with agent picker
    const dialog = page.locator('[data-testid="agent-picker"]');
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // Select first available agent
    const firstAgent = dialog.locator("label").first();
    await expect(firstAgent).toBeVisible();
    await firstAgent.click();

    // Type a message
    const messageInput = page.getByPlaceholder("Type your first message...");
    await messageInput.fill("Hello from E2E test");

    // Submit — button text is "Start Chat" or "Start Group Chat"
    const startBtn = page.getByRole("button", { name: /start.*chat/i });
    await expect(startBtn).toBeEnabled();
    await startBtn.click();

    // Wait for thread to load — message should appear in chat view
    await expect(
      page.getByText("Hello from E2E test")
    ).toBeVisible({ timeout: 15_000 });
  });

  test("agent responds to message", async ({ page }) => {
    await page.goto("/chat");
    await page.waitForLoadState("networkidle");

    // Create a new thread
    const newChatBtn = page.getByRole("button", { name: /new chat/i });
    await expect(newChatBtn).toBeVisible({ timeout: 10_000 });
    await newChatBtn.click();

    const dialog = page.locator('[data-testid="agent-picker"]');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.locator("label").first().click();

    const messageInput = page.getByPlaceholder("Type your first message...");
    await messageInput.fill("Say hello back");

    const startBtn = page.getByRole("button", { name: /start.*chat/i });
    await startBtn.click();

    // Wait for user message
    await expect(page.getByText("Say hello back")).toBeVisible({ timeout: 15_000 });

    // Wait for agent response — look for a second timestamp (means two messages rendered)
    // Give the agent up to 30 seconds to respond
    await expect(
      page.locator('[data-testid="message-timestamp"]').nth(1)
    ).toBeVisible({ timeout: 30_000 });
  });

  test("message timestamp is displayed", async ({ page }) => {
    await page.goto("/chat");
    await page.waitForLoadState("networkidle");

    // If there are existing threads, click the first one
    const threadItem = page.locator("a[href*='/chat/']").first();
    const hasThread = await threadItem.isVisible().catch(() => false);

    if (hasThread) {
      await threadItem.click();
      await page.waitForLoadState("networkidle");

      // Should see at least one timestamp
      await expect(
        page.locator('[data-testid="message-timestamp"]').first()
      ).toBeVisible({ timeout: 10_000 });
    } else {
      // No threads — skip this check (covered by create thread test)
      test.skip();
    }
  });
});
