import { createControlPlaneApi, createInMemoryRuns, emptyConfiguration } from "@tendworks/control-plane";
import { describe, expect, it } from "vitest";
import { runTend } from "./tend.js";

async function tend(args: string[]) {
  const api = createControlPlaneApi({
    probes: [],
    configuration: emptyConfiguration({
      workspaces: [
        { apiVersion: "tendworks.dev/v1", kind: "Workspace", metadata: { name: "app" }, spec: { git: { url: "https://git.example/acme/app.git", defaultBranch: "main" }, assistant: { enabled: true } } },
        { apiVersion: "tendworks.dev/v1", kind: "Workspace", metadata: { name: "notes" }, spec: { directory: { path: "/srv/workspaces/notes" }, assistant: { enabled: true, write: true } } },
        { apiVersion: "tendworks.dev/v1", kind: "Workspace", metadata: { name: "site" }, spec: { git: { url: "https://git.example/acme/site.git", defaultBranch: "main" } } },
      ],
    }),
    apiToken: "test-token",
    runs: createInMemoryRuns(),
  });
  let stdout = "";
  const exitCode = await runTend(["--token", "test-token", ...args], { fetch: (request) => api.fetch(request), stdout: (text) => (stdout += text), stderr: () => {} });
  return { exitCode, stdout };
}

describe("tend workspace list", () => {
  it("shows every workspace with its kind and assistant, and whether the assistant may write", async () => {
    const { exitCode, stdout } = await tend(["workspace", "list"]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^NAME\s+KIND\s+ASSISTANT$/m);
    expect(stdout).toMatch(/^app\s+git\s+workspace-assistant \(read-only\)$/m);
    expect(stdout).toMatch(/^notes\s+directory\s+workspace-assistant \(may write\)$/m);
    expect(stdout).toMatch(/^site\s+git\s+-$/m);
  });

  it("prints the list as JSON", async () => {
    const { stdout } = await tend(["workspace", "list", "-o", "json"]);

    expect(JSON.parse(stdout)).toMatchObject({ items: [{ name: "app", kind: "git", assistant: { profile: "workspace-assistant", write: false } }, { name: "notes" }, { name: "site" }] });
  });
});
