import { defineConfig, devices } from "@playwright/test";

/*
 * Browser end-to-end flows of the web UI against the running compose stack (`pnpm e2e` starts
 * it; `pnpm e2e:browser` runs only these). Each flow runs at desktop and at phone width.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: process.env.TEND_URL ?? "http://localhost:8080",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
});
