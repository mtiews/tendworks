import type { Workspace } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { createManualSource } from "./manual-source.js";

const workspace: Workspace.Workspace = {
  apiVersion: "tendworks.dev/v1",
  kind: "Workspace",
  metadata: { name: "app" },
  spec: { git: { url: "https://git.example/acme/app.git", defaultBranch: "main" } },
};

describe("manual trigger source", () => {
  it("has no schedule, so it is never checked on its own", () => {
    expect(createManualSource({}).schedule).toBeUndefined();
  });

  it("reports one item per firing, keyed by the time of the firing and started by hand, the same for every workspace", async () => {
    const source = createManualSource({});
    const at = new Date("2026-10-27T09:15:42.123Z");

    const item = { key: "2026-10-27T09:15:42.123Z", title: "started by hand" };
    expect(await source.items({ at })).toEqual([item]);
    expect(await source.items({ at, workspace })).toEqual([item]);
  });

  it("reports a new item at every firing", async () => {
    const source = createManualSource({});

    const keys = [...(await source.items({ at: new Date("2026-10-27T09:00:00.000Z") })), ...(await source.items({ at: new Date("2026-10-27T09:00:01.000Z") }))].map(
      (item) => item.key,
    );

    expect(keys).toEqual(["2026-10-27T09:00:00.000Z", "2026-10-27T09:00:01.000Z"]);
  });
});
