import { API_TOKEN, expect, expectNoHorizontalScroll, signIn, test } from "./support/test.js";

const MANUAL = "manual-over-two-workspaces"; // tests/fixtures/config/triggers, fired by hand over two workspaces

// Narrowed to the fake workspace, so the run needs no harness credential.
test("a manual binding is started from the Triggers page in one of its workspaces, and its run opens", async ({ page, request }) => {
  await page.goto("/ui/triggers");
  await signIn(page, API_TOKEN);

  const start = page.getByRole("button", { name: `Start ${MANUAL}`, exact: true });
  await expect(start).toBeEnabled({ timeout: 30_000 });
  await expectNoHorizontalScroll(page);
  await start.click();
  const dialog = page.getByRole("alertdialog", { name: `Start ${MANUAL}?` });
  await expect(dialog.getByRole("checkbox", { name: "fake-playground" })).toBeChecked();
  await dialog.getByRole("checkbox", { name: "scripted-playground" }).uncheck();
  await expectNoHorizontalScroll(page);
  await dialog.getByRole("button", { name: "Start runs" }).click();

  await expect(page).toHaveURL(/\/ui\/runs\/[^/]+$/);
  const runId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);
  const run = await request.get(`/runs/${encodeURIComponent(runId)}`, { headers: { authorization: `Bearer ${API_TOKEN}` } });
  expect(await run.json()).toMatchObject({ startedBy: { kind: "trigger", binding: MANUAL, workspace: "fake-playground", item: { title: "started by hand" } } });
});
