import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { API_TOKEN, expect, expectNoHorizontalScroll, signIn, test } from "./support/test.js";

/** The scripted ACP agent runs in the Claude Code harness, which needs some credential selected (CI sets one). */
function credentialSelected(): boolean {
  if (process.env.TEND_CLAUDE_CODE_CREDENTIAL) return true;
  const env = fileURLToPath(new URL("../../deploy/.env", import.meta.url));
  return existsSync(env) && /^TEND_CLAUDE_CODE_CREDENTIAL=(oauth-token|api-key)\s*$/m.test(readFileSync(env, "utf8"));
}

const baseUrl = process.env.TEND_URL ?? "http://localhost:8080";

async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: { authorization: `Bearer ${API_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered HTTP ${response.status}`);
  return (await response.json()) as T;
}

test("a running scripted agent step streams live in the run detail before it finishes", async ({ page }) => {
  test.skip(!credentialSelected(), "the scripted ACP agent needs TEND_CLAUDE_CODE_CREDENTIAL");
  test.setTimeout(180_000);

  // The scripted agent writes before.txt at once, then works for 90 seconds before it ends.
  const run = await api<{ id: string }>("POST", "/runs", { workflow: "restart-scripted" });
  await page.goto(`/ui/runs/${run.id}`);
  await signIn(page, API_TOKEN);

  const step = page.getByRole("region", { name: "/do/0/implement" });
  await expect(step).toBeVisible({ timeout: 60_000 });
  await expect(step.getByRole("status")).toHaveText("Live");
  await expect(step.getByRole("button", { name: /Write before\.txt/ })).toBeVisible({ timeout: 120_000 });

  // Still at work: what the page shows came through the stream, not from a finished transcript.
  const now = await api<{ status: string; steps: { status: string }[] }>("GET", `/runs/${run.id}`);
  expect(now.status).toBe("running");
  expect(now.steps[0]?.status).toBe("running");
  await expect(step.getByRole("status")).toHaveText("Live");
  await expectNoHorizontalScroll(page);
});
