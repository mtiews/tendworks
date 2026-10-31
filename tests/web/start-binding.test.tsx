import { createInMemoryTriggers, TriggerFireRefusedError, type FireTriggerRequest, type Trigger } from "@tendworks/control-plane";
import { StartBinding } from "@tendworks/web";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { READ_TOKEN, renderPage } from "./support/platform.js";

afterEach(cleanup);

const review: Trigger = { name: "architecture-review", workflow: "review-workspace", kind: "manual", workspaces: ["app"] };
const release: Trigger = { name: "release", workflow: "cut-release", kind: "manual", workspaces: [] };
const security: Trigger = { name: "security-review", workflow: "review-workspace", kind: "manual", workspaces: ["app", "web", "docs"] };

const disabled = (element: HTMLElement) => (element as HTMLButtonElement).disabled;

/** A page that starts `trigger` with "always confirm", as a page where a mistaken tap is likely would. */
function startPage(trigger: Trigger, triggers = createInMemoryTriggers([trigger]), token?: string) {
  return renderPage(<StartBinding trigger={trigger} alwaysConfirm />, { path: "/ui/", triggers, ...(token === undefined ? {} : { token }) });
}

describe("starting a manual binding with always confirm", () => {
  it("asks before starting a binding with one workspace, naming its workflow and workspace; confirming opens the run", async () => {
    const fake = createInMemoryTriggers([review]);
    const { user } = startPage(review, fake);

    await user.click(screen.getByRole("button", { name: "Start architecture-review" }));
    const dialog = screen.getByRole("alertdialog", { name: "Start architecture-review?" });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(within(dialog).getByText("Starts one run of review-workspace in app.")).toBeTruthy();
    expect(fake.fired).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Start run" }));

    await waitFor(() => expect(window.location.pathname).toBe("/ui/runs/run-1"));
    expect(fake.fired).toEqual([{ name: "architecture-review", request: {} }]);
  });

  it("asks before starting a binding without workspaces, naming its workflow", async () => {
    const fake = createInMemoryTriggers([release]);
    const { user } = startPage(release, fake);

    await user.click(screen.getByRole("button", { name: "Start release" }));
    const dialog = screen.getByRole("alertdialog", { name: "Start release?" });
    expect(within(dialog).getByText("Starts one run of cut-release.")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Start run" }));

    await waitFor(() => expect(window.location.pathname).toBe("/ui/runs/run-1"));
    expect(fake.fired).toEqual([{ name: "release", request: {} }]);
  });

  it("fires nothing on Cancel and gives the focus back to Start", async () => {
    const fake = createInMemoryTriggers([review]);
    const { user } = startPage(review, fake);

    const start = screen.getByRole("button", { name: "Start architecture-review" });
    await user.click(start);
    expect(start.getAttribute("aria-expanded")).toBe("true");
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(start);
    expect(fake.fired).toEqual([]);
    expect(window.location.pathname).toBe("/ui/");
  });

  it("fires nothing on Escape and gives the focus back to Start", async () => {
    const fake = createInMemoryTriggers([review]);
    const { user } = startPage(review, fake);

    const start = screen.getByRole("button", { name: "Start architecture-review" });
    await user.click(start);
    expect(document.activeElement?.textContent).toBe("Cancel");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(start);
    expect(fake.fired).toEqual([]);
  });

  it("fires once on a double confirm, with Start and the confirmation disabled while pending", async () => {
    const fake = createInMemoryTriggers([review]);
    let resolveFire: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (resolveFire = resolve));
    const fire = async (name: string, request: FireTriggerRequest) => {
      await held;
      return fake.fire(name, request);
    };
    const { user } = startPage(review, { ...fake, fire });

    const start = screen.getByRole("button", { name: "Start architecture-review" });
    await user.click(start);
    const confirm = within(screen.getByRole("alertdialog")).getByRole("button", { name: "Start run" });
    await user.click(confirm);
    expect(disabled(confirm)).toBe(true);
    expect(disabled(start)).toBe(true);
    await user.click(confirm);
    resolveFire();

    await waitFor(() => expect(window.location.pathname).toBe("/ui/runs/run-1"));
    expect(fake.fired).toHaveLength(1);
  });

  it("offers the choice of several workspaces inside the confirmation, all preselected, and cannot confirm with none", async () => {
    const fake = createInMemoryTriggers([security]);
    const { user } = startPage(security, fake);

    await user.click(screen.getByRole("button", { name: "Start security-review" }));
    const dialog = screen.getByRole("alertdialog", { name: "Start security-review?" });
    expect(within(dialog).getAllByRole("checkbox").map((box) => [box.closest("label")?.textContent, (box as HTMLInputElement).checked])).toEqual([
      ["app", true],
      ["web", true],
      ["docs", true],
    ]);
    for (const workspace of ["app", "web", "docs"]) await user.click(within(dialog).getByRole("checkbox", { name: workspace }));
    expect(disabled(within(dialog).getByRole("button", { name: "Start runs" }))).toBe(true);
    await user.click(within(dialog).getByRole("checkbox", { name: "web" }));
    await user.click(within(dialog).getByRole("button", { name: "Start runs" }));

    await waitFor(() => expect(window.location.pathname).toBe("/ui/runs/run-1"));
    expect(fake.fired).toEqual([{ name: "security-review", request: { workspace: "web" } }]);
  });

  it("shows why a start was refused, and Start stays usable", async () => {
    const fake = createInMemoryTriggers([review]);
    const fire = () => Promise.reject(new TriggerFireRefusedError(409, "Conflict", "trigger binding 'architecture-review' is suspended"));
    const { user } = startPage(review, { ...fake, fire });

    await user.click(screen.getByRole("button", { name: "Start architecture-review" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Start run" }));

    expect(await screen.findByText("Conflict: trigger binding 'architecture-review' is suspended")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(window.location.pathname).toBe("/ui/");
    expect(disabled(screen.getByRole("button", { name: "Start architecture-review" }))).toBe(false);
  });

  it("offers no Start for read-only access", () => {
    startPage(review, createInMemoryTriggers([review]), READ_TOKEN);

    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("offers a disabled Start for a suspended binding", () => {
    const suspended = { ...review, suspended: true };
    startPage(suspended, createInMemoryTriggers([suspended]));

    expect(disabled(screen.getByRole("button", { name: "Start architecture-review" }))).toBe(true);
  });
});
