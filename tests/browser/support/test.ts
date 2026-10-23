import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test as base, type Page } from "@playwright/test";

/**
 * A token of the compose stack, as compose reads it: from the environment, or else from
 * deploy/.env, which scripts/setup-env.sh creates. The stack has no default tokens.
 */
function stackToken(name: string): string {
  const env = fileURLToPath(new URL("../../../deploy/.env", import.meta.url));
  const value = process.env[name] || (existsSync(env) ? new RegExp(`^${name}=(.*)$`, "m").exec(readFileSync(env, "utf8"))?.[1]?.trim() : undefined);
  if (!value) throw new Error(`${name} is set neither in the environment nor in deploy/.env; create deploy/.env with scripts/setup-env.sh`);
  return value;
}

export const API_TOKEN = stackToken("TEND_API_TOKEN");
export const READ_TOKEN = stackToken("TEND_API_READ_TOKEN");

/**
 * Every flow fails on a Content Security Policy violation or an uncaught error in the page:
 * the UI must work under the strict policy the server sends (ADR 0018).
 */
export const test = base.extend<{ problems: string[]; openTab: () => Promise<Page> }>({
  problems: [
    async ({ page }, use) => {
      const problems: string[] = [];
      watch(page, problems);
      await use(problems);
      expect(problems).toEqual([]);
    },
    { auto: true },
  ],
  /** A second tab in the same browser, watched like the first. */
  openTab: async ({ context, problems }, use) => {
    await use(async () => {
      const tab = await context.newPage();
      watch(tab, problems);
      return tab;
    });
  },
});

function watch(page: Page, problems: string[]) {
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy|Refused to/i.test(message.text())) problems.push(`CSP: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
}

/** The scripted ACP agent runs in the Claude Code harness, which needs some credential selected (CI sets one). */
export function credentialSelected(): boolean {
  if (process.env.TEND_CLAUDE_CODE_CREDENTIAL) return true;
  const env = fileURLToPath(new URL("../../../deploy/.env", import.meta.url));
  return existsSync(env) && /^TEND_CLAUDE_CODE_CREDENTIAL=(oauth-token|api-key)\s*$/m.test(readFileSync(env, "utf8"));
}

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
