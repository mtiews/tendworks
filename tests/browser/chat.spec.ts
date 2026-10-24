import type { Page } from "@playwright/test";
import { API_TOKEN, credentialSelected, expect, expectNoHorizontalScroll, signIn, test } from "./support/test.js";

const conversation = (page: Page) => page.getByRole("region", { name: "Conversation" });
const transcript = (page: Page) => conversation(page).getByRole("list", { name: "Transcript" });
const input = (page: Page) => conversation(page).getByRole("textbox", { name: "Message" });

async function send(page: Page, text: string) {
  await expect(input(page)).toBeEnabled({ timeout: 60_000 });
  await input(page).fill(text);
  await conversation(page).getByRole("button", { name: "Send" }).click();
}

// The scripted ACP agent (images/sandbox-scripted-acp) answers a prompt starting with "chat:"
// at once with every chat prompt so far, and works on any other prompt until cancelled.
test("a chat followed in two tabs is written from both, cancelled and ended", async ({ page, openTab }) => {
  test.skip(!credentialSelected(), "the scripted ACP agent needs TEND_CLAUDE_CODE_CREDENTIAL");
  test.setTimeout(240_000);

  await page.goto("/ui/chats/new");
  await signIn(page, API_TOKEN);
  await page.getByRole("combobox", { name: "Chat with" }).selectOption("scripted-assistant");
  await page.getByRole("textbox", { name: "Message" }).fill("chat: My name is Ada.");
  await page.getByRole("button", { name: "Start chat" }).click();
  await expect(page).toHaveURL(/\/ui\/chats\/[^/]+$/);
  await expect(transcript(page)).toContainText("I remember: My name is Ada.", { timeout: 120_000 });

  // The same chat in a second tab, signed in there too (the token stays in its tab).
  const other = await openTab();
  await other.goto(page.url());
  await signIn(other, API_TOKEN);
  await expect(transcript(other)).toContainText("I remember: My name is Ada.");

  // Either tab continues the chat; both see every turn.
  await send(other, "chat: I bake bread.");
  for (const tab of [page, other]) await expect(transcript(tab)).toContainText("I remember: My name is Ada. | I bake bread.", { timeout: 60_000 });

  // A long turn started in one tab is cancelled from the other; the chat waits for the next message.
  await send(page, "Work for a long time.");
  await expect(conversation(other).getByRole("button", { name: /Write before\.txt/ })).toBeVisible({ timeout: 60_000 });
  await expect(input(page)).toBeDisabled();
  await conversation(other).getByRole("button", { name: "Cancel turn" }).click();
  for (const tab of [page, other]) {
    await expect(transcript(tab)).toContainText("Turn cancelled", { timeout: 60_000 });
    await expect(input(tab)).toBeEnabled();
  }
  await expectNoHorizontalScroll(other);

  // Ending it in one tab shows it ended in the other, without input.
  await conversation(page).getByRole("button", { name: "End chat" }).click();
  await page.getByRole("alertdialog", { name: "End this chat?" }).getByRole("button", { name: "End chat" }).click();
  for (const tab of [page, other]) {
    await expect(conversation(tab).getByText("This chat has ended.")).toBeVisible({ timeout: 60_000 });
    await expect(input(tab)).toHaveCount(0);
  }
  await expectNoHorizontalScroll(page);
});
