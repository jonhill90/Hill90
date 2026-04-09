import { test, expect, type Page } from "@playwright/test";

/**
 * Agent chat flow E2E tests.
 *
 * Verifies the full lifecycle: start agent → create chat thread → send command →
 * verify response → inspect Live Session (terminal + browser tabs).
 *
 * Requires env vars:
 *   E2E_USERNAME — Keycloak user (default: jon)
 *   E2E_PASSWORD — Keycloak password
 */

const E2E_USERNAME = process.env.E2E_USERNAME || "jon";
const E2E_PASSWORD = process.env.E2E_PASSWORD || "";

test.skip(!E2E_PASSWORD, "E2E_PASSWORD not set — skipping agent chat flow E2E tests");

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

/** Ensure at least one agent is running. Returns the agent name. */
async function ensureRunningAgent(page: Page): Promise<string> {
  await page.goto("/agents");
  await page.waitForLoadState("networkidle");

  await expect(
    page.getByRole("heading", { name: /agents/i })
  ).toBeVisible({ timeout: 10_000 });

  // Check if any agent is already running
  const runningBadge = page.getByText("Running", { exact: true }).first();
  if (await runningBadge.isVisible().catch(() => false)) {
    // Find the name of the running agent's card
    const card = runningBadge.locator("xpath=ancestor::div[contains(@class,'rounded')]").first();
    const name = await card.locator("a").first().textContent();
    return name?.trim() || "Agent";
  }

  // No running agents — start the first stopped one
  const startBtn = page.getByRole("button", { name: "Start" }).first();
  await expect(startBtn).toBeVisible({ timeout: 5_000 });
  await startBtn.click();

  // Wait for status to flip to Running
  await expect(
    page.getByText("Running", { exact: true }).first()
  ).toBeVisible({ timeout: 15_000 });

  // Get the agent name from the first card showing Running
  const firstRunning = page.getByText("Running", { exact: true }).first();
  const agentCard = firstRunning.locator("xpath=ancestor::div[contains(@class,'rounded')]").first();
  const agentName = await agentCard.locator("a").first().textContent();
  return agentName?.trim() || "Agent";
}

test.describe("Agent Chat Flow", () => {
  test.setTimeout(90_000);

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("full agent chat lifecycle: start → chat → ls -a → live session", async ({ page }) => {
    // ── Step 1: Ensure an agent is running ──
    await ensureRunningAgent(page);

    // ── Step 2: Navigate to chat and create a new thread ──
    await page.goto("/chat");
    await page.waitForLoadState("networkidle");

    const newBtn = page.getByRole("button", { name: /\+ new/i });
    await expect(newBtn).toBeVisible({ timeout: 10_000 });
    await newBtn.click();

    // Wait for agent picker dialog
    const agentPicker = page.locator('[data-testid="agent-picker"]');
    await expect(agentPicker).toBeVisible({ timeout: 10_000 });

    // Select first available agent (click label container, not sr-only checkbox)
    const agentLabel = agentPicker.locator("label").first();
    await expect(agentLabel).toBeVisible();
    await agentLabel.click();

    // Type command
    const messageInput = page.getByPlaceholder("Type your first message...");
    await messageInput.fill("ls -a");

    // Start chat
    const startBtn = page.getByRole("button", { name: /start.*chat/i });
    await expect(startBtn).toBeEnabled();
    await startBtn.click();

    // ── Step 3: Verify user message appears ──
    await expect(page.getByText("ls -a").first()).toBeVisible({ timeout: 15_000 });

    // ── Step 4: Wait for agent response with directory listing ──
    // The agent runs `ls -a` in the container and returns output containing
    // common dotfiles. Wait for at least one known entry.
    await expect(
      page.getByText(/\.cache|\.bashrc|\.profile/i).first()
    ).toBeVisible({ timeout: 30_000 });

    // Verify it's not a login error — response should contain typical
    // directory entries, not authentication error messages
    const responseText = await page.locator('[data-testid="message-timestamp"]')
      .nth(1).locator("xpath=ancestor::div[contains(@class,'space-y')]")
      .first().textContent().catch(() => "");
    expect(responseText).not.toMatch(/unauthorized|login|403|401/i);

    // ── Step 5: Toggle Live Session and verify terminal ──
    const sessionToggle = page.getByTestId("session-toggle");
    await sessionToggle.click();

    // Session pane should appear with Terminal tab active
    const sessionPane = page.getByTestId("session-pane");
    await expect(sessionPane).toBeVisible({ timeout: 10_000 });

    // Terminal pane should be visible (xterm container)
    const terminalPane = page.getByTestId("terminal-pane");
    await expect(terminalPane).toBeVisible({ timeout: 10_000 });

    // ── Step 6: Click Browser tab and verify inactive state ──
    const browserTab = page.getByTestId("browser-tab");
    await browserTab.click();

    const browserInactive = page.getByTestId("browser-inactive");
    await expect(browserInactive).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText("Browser not active")
    ).toBeVisible();
  });

  test.afterAll(async ({ browser }) => {
    // Clean up: stop any agents we started (best-effort)
    const page = await browser.newPage();
    try {
      await login(page);
      await page.goto("/agents");
      await page.waitForLoadState("networkidle");

      const stopAllBtn = page.getByRole("button", { name: /stop all/i });
      if (await stopAllBtn.isVisible().catch(() => false)) {
        // Accept the confirm dialog
        page.once("dialog", (dialog) => dialog.accept());
        await stopAllBtn.click();
        await page.waitForTimeout(2_000);
      }
    } catch {
      // Best-effort cleanup
    } finally {
      await page.close();
    }
  });
});
