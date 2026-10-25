import { API_TOKEN, expect, expectNoHorizontalScroll, signIn, test } from "./support/test.js";

// Fakes only: wait-for-merge's human step asks before its follow-up step
// (tests/e2e/approvals.test.ts); the fake agent reports a pull request on git.example.
test("a run waiting on its human step continues after answering in the browser", async ({ page, request }, testInfo) => {
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

  // On a phone the request is a bar at the bottom of the screen, its answers within reach of the thumb.
  if (testInfo.project.name === "phone") {
    const viewport = page.viewportSize()!;
    const bar = (await approval.boundingBox())!;
    expect(bar.y + bar.height).toBeGreaterThan(viewport.height * 0.75);
    for (const answer of await approval.getByRole("button").all()) expect((await answer.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }

  await approval.getByRole("button", { name: "Merged – continue" }).click();
  const confirmation = page.getByRole("alertdialog", { name: "Answer “Merged – continue”?" });
  await expect(confirmation).toContainText("The run continues.");
  await expect(confirmation.getByRole("button", { name: "Not now" })).toBeFocused();
  await confirmation.getByRole("button", { name: "Merged – continue" }).click();

  await expect(page.getByRole("status")).toHaveText("Answered “Merged – continue”. The run continues.");
  await expect(page.getByRole("definition").filter({ hasText: /^completed$/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("tab", { name: "Output" }).click();
  await expect(page.getByRole("table", { name: "Output" })).toContainText("followedUp");

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Inbox" }).click();
  await page.getByRole("navigation", { name: "Inbox" }).getByRole("link", { name: "Approval requests" }).click();
  const card = page.getByRole("listitem").filter({ hasText: runId });
  await expect(card).toContainText("Merged – continue");
  await expect(card.getByRole("button")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});
