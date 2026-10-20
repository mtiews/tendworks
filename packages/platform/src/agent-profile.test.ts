import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DEFAULT_CHAT_IDLE_MINUTES } from "./index.js";

describe("agent profile defaults", () => {
  it("idles a chat after the minutes the agent profile schema names as the default", () => {
    const schema = parse(readFileSync(new URL("../../../contracts/schemas/agent-profile.schema.yaml", import.meta.url), "utf8")) as {
      $defs: { chatSettings: { properties: { idleMinutes: { default: number } } } };
    };

    expect(DEFAULT_CHAT_IDLE_MINUTES).toBe(schema.$defs.chatSettings.properties.idleMinutes.default);
  });
});
