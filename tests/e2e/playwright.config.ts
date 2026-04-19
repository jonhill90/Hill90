import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    ignoreHTTPSErrors: false,
  },
  projects: [
    {
      name: "smoke",
      testMatch: "smoke.spec.ts",
      use: {
        baseURL: "https://hill90.com",
        browserName: "chromium",
      },
    },
    {
      name: "auth",
      testMatch: "auth-theme.spec.ts",
      use: {
        baseURL: "https://auth.hill90.com",
        browserName: "chromium",
      },
    },
    {
      name: "app",
      testMatch: ["chat.spec.ts", "agent-chat-flow.spec.ts", "secrets.spec.ts", "workflows.spec.ts", "mcp-servers.spec.ts", "library-search.spec.ts", "topbar-features.spec.ts", "storage-upload.spec.ts"],
      use: {
        baseURL: "https://hill90.com",
        browserName: "chromium",
      },
    },
  ],
});
