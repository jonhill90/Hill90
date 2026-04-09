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
      name: "auth",
      testMatch: "auth-theme.spec.ts",
      use: {
        baseURL: "https://auth.hill90.com",
        browserName: "chromium",
      },
    },
    {
      name: "app",
      testMatch: ["chat.spec.ts", "agent-chat-flow.spec.ts", "secrets.spec.ts"],
      use: {
        baseURL: "https://hill90.com",
        browserName: "chromium",
      },
    },
  ],
});
