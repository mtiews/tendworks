import { API_TOKEN, expect, expectNoHorizontalScroll, READ_TOKEN, signIn, signOut, test } from "./support/test.js";

test("the platform's root address leads to sign-in, served under a strict content security policy", async ({ page }) => {
  const response = await page.goto("/");

  expect(new URL(page.url()).pathname).toBe("/ui/");
  expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expectNoHorizontalScroll(page);
});

const SECTIONS = ["Overview", "Runs", "Chats", "Inbox", "More"];

test("signs in with the API token and shows full access and the navigation", async ({ page }) => {
  await page.goto("/ui/");

  await signIn(page, API_TOKEN);

  await expect(page.getByText("Full access")).toBeVisible();
  const navigation = page.getByRole("navigation", { name: "Main" });
  for (const section of SECTIONS) await expect(navigation.getByRole("link", { name: section })).toBeVisible();
  // The start page is the overview.
  await expect(navigation.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  await navigation.getByRole("link", { name: "Runs" }).click();
  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Runs" })).toHaveAttribute("aria-current", "page");
  expect(page.url()).not.toContain(API_TOKEN);
  await expectNoHorizontalScroll(page);
});

test("shows the navigation as an icon rail on a desktop and as bottom tabs on a phone, with touch targets of 44px at any width", async ({ page }, testInfo) => {
  await page.goto("/ui/");
  await signIn(page, API_TOKEN);
  await expect(page.getByText("Full access")).toBeVisible();

  const navigation = page.getByRole("navigation", { name: "Main" });
  const phone = testInfo.project.name === "phone";
  const targets = SECTIONS.map((section) => navigation.getByRole("link", { name: section }));
  if (!phone) targets.push(page.getByRole("button", { name: "Sign out" }), navigation.getByRole("link", { name: "Tendworks" }));
  for (const target of targets) {
    await expect(target).toBeInViewport({ ratio: 1 });
    const box = (await target.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
  // Rail on the left edge, tabs along the bottom edge.
  const viewport = page.viewportSize()!;
  const first = (await targets[0]!.boundingBox())!;
  if (phone) expect(first.y).toBeGreaterThan(viewport.height / 2);
  else expect(first.x).toBeLessThan(viewport.width / 4);
  await expect(page.getByText("Full access")).toBeInViewport({ ratio: 1 });
  await expectNoHorizontalScroll(page);

  // Every section fits the width, with the access scope in view.
  for (const section of SECTIONS) {
    await navigation.getByRole("link", { name: section }).click();
    await expect(navigation.getByRole("link", { name: section })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Full access")).toBeInViewport({ ratio: 1 });
    await expectNoHorizontalScroll(page);
  }
});

test("lets the operator choose the start page under More, and keeps it over a reload", async ({ page }) => {
  await page.goto("/ui/");
  await signIn(page, API_TOKEN, { remember: true });
  const navigation = page.getByRole("navigation", { name: "Main" });
  await navigation.getByRole("link", { name: "More" }).click();

  await page.getByRole("radio", { name: "Runs" }).check();
  await page.goto("/ui/");

  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Runs" })).toHaveAttribute("aria-current", "page");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
});

test("signs in with the read-only token and shows that the UI only reads", async ({ page }) => {
  await page.goto("/ui/chats");

  await signIn(page, READ_TOKEN);

  await expect(page.getByText("Read-only")).toBeVisible();
  await expect(page.getByText("Read-only")).toBeInViewport({ ratio: 1 });
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

  await signOut(page);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});
