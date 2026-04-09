import { test, expect, type Page } from "@playwright/test";

/**
 * Storage upload E2E tests.
 *
 * Verifies the full upload lifecycle: navigate to storage, open bucket,
 * upload a test file, verify it appears in the listing, delete it,
 * verify it's gone.
 *
 * Requires env vars:
 *   E2E_USERNAME — Keycloak user (default: jon)
 *   E2E_PASSWORD — Keycloak password
 */

const E2E_USERNAME = process.env.E2E_USERNAME || "jon";
const E2E_PASSWORD = process.env.E2E_PASSWORD || "";

test.skip(!E2E_PASSWORD, "E2E_PASSWORD not set — skipping storage E2E tests");

async function login(page: Page) {
  await page.goto("/");

  // next-auth may show its own signin page first
  if (page.url().includes("/api/auth/signin")) {
    await page.getByRole("button", { name: /sign in with keycloak/i }).click();
  }

  // Fill Keycloak credentials if redirected
  if (page.url().includes("auth.hill90.com")) {
    await page.getByLabel(/username or email/i).fill(E2E_USERNAME);
    await page.getByRole("textbox", { name: /password/i }).fill(E2E_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/hill90\.com\//, { timeout: 15_000 });
  }
}

const TEST_FILE_NAME = "e2e-test-upload.txt";

test.describe("Storage Upload", () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("upload file, verify in listing, delete, verify gone", async ({ page }) => {
    // ── Navigate to storage page ──
    await page.goto("/harness/storage");
    await page.waitForLoadState("networkidle");

    // Should see buckets
    await expect(
      page.getByRole("heading", { name: /storage/i })
    ).toBeVisible({ timeout: 10_000 });

    // ── Open agent-avatars bucket ──
    const bucketBtn = page.getByRole("button", { name: /agent-avatars/i });
    await expect(bucketBtn).toBeVisible({ timeout: 10_000 });
    await bucketBtn.click();

    // Should see bucket header and Upload button
    await expect(
      page.getByRole("heading", { name: "agent-avatars" })
    ).toBeVisible({ timeout: 10_000 });
    const uploadBtn = page.getByRole("button", { name: "Upload" });
    await expect(uploadBtn).toBeVisible();

    // ── Upload a test file ──
    // Create a file chooser listener before clicking Upload
    const fileChooserPromise = page.waitForEvent("filechooser");
    await uploadBtn.click();
    const fileChooser = await fileChooserPromise;

    // Create test content as a buffer and set it on the file chooser
    const testContent = `e2e-storage-test-${Date.now()}`;
    await fileChooser.setFiles({
      name: TEST_FILE_NAME,
      mimeType: "text/plain",
      buffer: Buffer.from(testContent),
    });

    // ── Verify file appears in listing ──
    await expect(
      page.getByText(TEST_FILE_NAME)
    ).toBeVisible({ timeout: 15_000 });

    // Verify the table row contains size info
    const fileRow = page.getByRole("row", { name: new RegExp(TEST_FILE_NAME) });
    await expect(fileRow).toBeVisible();

    // ── Delete the file ──
    // Set up dialog handler to accept the confirm prompt
    page.once("dialog", (dialog) => dialog.accept());

    const deleteBtn = page.getByRole("button", { name: `Delete ${TEST_FILE_NAME}` });
    await expect(deleteBtn).toBeVisible();
    await deleteBtn.click();

    // ── Verify file is gone ──
    await expect(
      page.getByText("This bucket is empty")
        .or(page.getByText(TEST_FILE_NAME))
    ).toBeVisible({ timeout: 10_000 });

    // The file name should no longer be in a table row
    await expect(
      page.getByRole("row", { name: new RegExp(TEST_FILE_NAME) })
    ).not.toBeVisible({ timeout: 5_000 });
  });
});
