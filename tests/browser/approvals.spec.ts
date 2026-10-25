import { API_TOKEN, expect, expectNoHorizontalScroll, signIn, test } from "./support/test.js";

// Fakes only: wait-for-merge's human step asks before its follow-up step
// (tests/e2e/approvals.test.ts); the fake agent reports a pull request on git.example.
test("a run waiting on its human step continues after answering in the browser", async ({ page, request }) => {
  const started = await request.post("/runs", {
    headers: { authorization: `Bearer ${API_TOKEN}` },
    data: { workflow: "wait-for-merge", input: { issue: { number: 43, title: "Answer in the browser" } } },
  });
  expect(started.status()).toBe(201);
  const { id: runId } = (await started.json()) as { id: string };

  await page.goto(`/ui/runs/${runId}`);
  await signIn(page, API_TOKEN);

  const approval = page.getByRole("region", { name: "Approval request" });
  await expect(approval).toBeVisible({ timeout: 30_000 });
  await expect(approval).toContainText("then continue?");
  await expect(approval.getByRole("link", { name: "Pull request" })).toHaveAttribute("href", "https://git.example/example/playground/pull/1");
  await expect(approval.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expectNoHorizontalScroll(page);

  await approval.getByRole("button", { name: "Merged – continue" }).click();
  const confirmation = page.getByRole("alertdialog", { name: "Answer “Merged – continue”?" });
  await expect(confirmation).toContainText("The run continues.");
  await expect(confirmation.getByRole("button", { name: "Not now" })).toBeFocused();
  await confirmation.getByRole("button", { name: "Merged – continue" }).click();

  await expect(page.getByRole("status")).toHaveText("Answered “Merged – continue”. The run continues.");
  await expect(page.getByRole("definition").filter({ hasText: /^completed$/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("table", { name: "Output" })).toContainText("followedUp");

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "More" }).click();
  await page.getByRole("link", { name: "Approval requests" }).click();
  const row = page.getByRole("row").filter({ hasText: runId });
  await expect(row).toContainText("decided");
  await expect(row).toContainText("Merged – continue");
  await expect(row.getByRole("button")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});
