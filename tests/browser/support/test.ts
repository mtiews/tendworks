import { expect, test as base, type Page } from "@playwright/test";

/** The compose stack's tokens: deploy/.env, or the laptop profile's defaults in deploy/compose.yaml. */
export const API_TOKEN = process.env.TEND_API_TOKEN || "laptop-only-insecure-api-token";
export const READ_TOKEN = process.env.TEND_API_READ_TOKEN || "laptop-only-insecure-read-token";

/**
 * Every flow fails on a Content Security Policy violation or an uncaught error in the page:
 * the UI must work under the strict policy the server sends (ADR 0018).
 */
export const test = base.extend<{ problems: string[] }>({
  problems: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error" && /Content Security Policy|Refused to/i.test(message.text())) problems.push(`CSP: ${message.text()}`);
      });
      page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
      await use(problems);
      expect(problems).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export async function signIn(page: Page, token: string, { remember = false } = {}) {
  await page.getByLabel("API token").fill(token);
  if (remember) await page.getByLabel("Stay signed in on this device").check();
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** The page fits the viewport: nothing makes it scroll sideways. */
export async function expectNoHorizontalScroll(page: Page) {
  // Runs in the page; this project's types have no DOM, so the page's root element is untyped here.
  const overflow = await page.evaluate(() => {
    const root = (globalThis as unknown as { document: { documentElement: { scrollWidth: number; clientWidth: number } } }).document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
}
