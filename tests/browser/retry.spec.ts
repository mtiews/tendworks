import { API_TOKEN, expect, expectNoHorizontalScroll, signIn, test } from "./support/test.js";

// Fakes only: requires-pull-request fails because the fake agent reports no pull request
// (tests/e2e/runs.test.ts); its retry fails the same way.
test("a failed run is retried from the browser and the new run links back to it", async ({ page, request }) => {
  const headers = { authorization: `Bearer ${API_TOKEN}` };
  const started = await request.post("/runs", { headers, data: { workflow: "requires-pull-request", input: { item: { key: "browser-retry", title: "Retry in the browser", number: 44 } } } });
  expect(started.status()).toBe(201);
  const { id: runId } = (await started.json()) as { id: string };

  await page.goto(`/ui/runs/${runId}`);
  await signIn(page, API_TOKEN);

  const retry = page.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible({ timeout: 30_000 });
  await expectNoHorizontalScroll(page);
  await retry.click();
  const confirmation = page.getByRole("alertdialog", { name: `Retry run ${runId}?` });
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirmation.getByRole("button", { name: "Retry run" }).click();

  await expect(page).not.toHaveURL(new RegExp(`/ui/runs/${runId}$`));
  const back = page.getByRole("link", { name: runId, exact: true });
  await expect(back).toBeVisible();
  await expectNoHorizontalScroll(page);
  await back.click();
  await expect(page).toHaveURL(new RegExp(`/ui/runs/${runId}$`));
});
