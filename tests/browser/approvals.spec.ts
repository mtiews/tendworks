import { API_TOKEN, expect, expectNoHorizontalScroll, signIn, test } from "./support/test.js";

// Fakes only: the policy ask-before-merge asks before merging fake-develop-and-ask's pull
// request, which the server merges in its fake integration once approved (tests/e2e/approvals.test.ts).
test("a run waiting on an approval request continues after approving it in the browser", async ({ page, request }) => {
  const started = await request.post("/runs", {
    headers: { authorization: `Bearer ${API_TOKEN}` },
    data: { workflow: "fake-develop-and-ask", input: { issue: { number: 43, title: "Approve in the browser" } } },
  });
  expect(started.status()).toBe(201);
  const { id: runId } = (await started.json()) as { id: string };

  await page.goto(`/ui/runs/${runId}`);
  await signIn(page, API_TOKEN);

  const approval = page.getByRole("region", { name: "Approval request" });
  await expect(approval).toBeVisible({ timeout: 30_000 });
  await expect(approval).toContainText(runId);
  await expectNoHorizontalScroll(page);

  await approval.getByRole("button", { name: "Approve" }).click();
  const confirmation = page.getByRole("alertdialog", { name: "Approve this request?" });
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirmation.getByRole("button", { name: "Approve" }).click();

  await expect(page.getByRole("status")).toHaveText("Approval request approved. The run continues.");
  await expect(page.getByRole("definition").filter({ hasText: /^completed$/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("table", { name: "Output" })).toContainText("merged");

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Approval requests" }).click();
  const row = page.getByRole("row").filter({ hasText: runId });
  await expect(row).toContainText("approved");
  await expect(row.getByRole("button")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});
