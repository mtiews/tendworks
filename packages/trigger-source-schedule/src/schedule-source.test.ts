import type { Workspace } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { createScheduleSource } from "./schedule-source.js";

const workspace: Workspace.Workspace = {
  apiVersion: "tendworks.dev/v1",
  kind: "Workspace",
  metadata: { name: "app" },
  spec: { git: { url: "https://git.example/acme/app.git", defaultBranch: "main" } },
};

describe("schedule trigger source", () => {
  it("is checked on its cron expression or its interval", () => {
    expect(createScheduleSource({ cron: "0 2 * * *" }).schedule).toEqual({ cron: "0 2 * * *" });
    expect(createScheduleSource({ every: { hours: 6 } }).schedule).toEqual({ every: { hours: 6 } });
  });

  it("reports the tick of the execution as the one item, the same for every workspace", async () => {
    const source = createScheduleSource({ cron: "0 2 * * *" });
    const at = new Date("2026-10-18T02:00:00.000Z");

    const tick = { key: "2026-10-18T02:00:00.000Z", title: "Scheduled at 2026-10-18T02:00:00.000Z", at: "2026-10-18T02:00:00.000Z" };
    expect(await source.items({ at })).toEqual([tick]);
    expect(await source.items({ at, workspace })).toEqual([tick]);
  });

  it("reports a new tick at every execution", async () => {
    const source = createScheduleSource({ every: { hours: 6 } });

    const keys = [
      ...(await source.items({ at: new Date("2026-10-18T00:00:00.000Z") })),
      ...(await source.items({ at: new Date("2026-10-18T06:00:00.000Z") })),
    ].map((item) => item.key);

    expect(keys).toEqual(["2026-10-18T00:00:00.000Z", "2026-10-18T06:00:00.000Z"]);
  });
});
