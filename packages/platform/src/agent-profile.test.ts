import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DEFAULT_CHAT_IDLE_MINUTES, DEFAULT_WORKSPACE_ASSISTANT_PROFILE, enabledAssistant } from "./index.js";

describe("agent profile defaults", () => {
  it("idles a chat after the minutes the agent profile schema names as the default", () => {
    const schema = parse(readFileSync(new URL("../../../contracts/schemas/agent-profile.schema.yaml", import.meta.url), "utf8")) as {
      $defs: { chatSettings: { properties: { idleMinutes: { default: number } } } };
    };

    expect(DEFAULT_CHAT_IDLE_MINUTES).toBe(schema.$defs.chatSettings.properties.idleMinutes.default);
  });
});

describe("workspace assistant defaults", () => {
  const schema = parse(readFileSync(new URL("../../../contracts/schemas/workspace.schema.yaml", import.meta.url), "utf8")) as {
    $defs: { workspaceAssistant: { properties: { enabled: { default: boolean }; profile: { default: string }; write: { default: boolean } } } };
  };
  const { properties } = schema.$defs.workspaceAssistant;

  it("holds an enabled assistant with the profile and write mode the workspace schema names as defaults", () => {
    expect(DEFAULT_WORKSPACE_ASSISTANT_PROFILE).toBe(properties.profile.default);
    expect(enabledAssistant({ enabled: true })).toEqual({ profile: properties.profile.default, write: properties.write.default });
    expect(enabledAssistant({ enabled: true, profile: "app-assistant", write: true })).toEqual({ profile: "app-assistant", write: true });
  });

  it("has no assistant unless it is enabled", () => {
    expect(properties.enabled.default).toBe(false);
    expect(enabledAssistant(undefined)).toBeUndefined();
    expect(enabledAssistant({ profile: "app-assistant" })).toBeUndefined();
  });
});
