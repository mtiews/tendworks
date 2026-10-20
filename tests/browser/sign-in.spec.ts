import { API_TOKEN, expect, expectNoHorizontalScroll, READ_TOKEN, signIn, test } from "./support/test.js";

test("the platform's root address leads to sign-in, served under a strict content security policy", async ({ page }) => {
  const response = await page.goto("/");

  expect(new URL(page.url()).pathname).toBe("/ui/");
  expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test("signs in with the API token and shows full access and the navigation", async ({ page }) => {
  await page.goto("/ui/");

  await signIn(page, API_TOKEN);

  await expect(page.getByText("Full access")).toBeVisible();
  const navigation = page.getByRole("navigation", { name: "Main" });
  for (const view of ["Status", "Runs", "Approval requests", "Notifications", "Chats"]) await expect(navigation.getByRole("link", { name: view })).toBeAttached();
  await navigation.getByRole("link", { name: "Runs" }).click();
  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  expect(page.url()).not.toContain(API_TOKEN);
  await expectNoHorizontalScroll(page);
});

test("signs in with the read-only token and shows that the UI only reads", async ({ page }) => {
  await page.goto("/ui/chats");

  await signIn(page, READ_TOKEN);

  await expect(page.getByText("Read-only")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chats" })).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test("refuses a wrong token, and forgets a token on sign-out", async ({ page }) => {
  await page.goto("/ui/");

  await signIn(page, "not-the-token");
  await expect(page.getByRole("alert")).toHaveText("This token is not accepted. Check it and try again.");

  await page.getByLabel("API token").clear();
  await signIn(page, API_TOKEN, { remember: true });
  await expect(page.getByText("Full access")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Full access")).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});
