import type { Workspace } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { createControlPlaneApi, createInMemoryRuns, emptyConfiguration } from "./index.js";

const workspace = (name: string, spec: Workspace.WorkspaceSpec): Workspace.Workspace => ({ apiVersion: "tendworks.dev/v1", kind: "Workspace", metadata: { name }, spec });

function setup(workspaces: Workspace.Workspace[]) {
  const api = createControlPlaneApi({
    probes: [],
    configuration: emptyConfiguration({ workspaces }),
    runs: createInMemoryRuns(),
    apiToken: "test-token",
    readToken: "read-only-test-token",
  });
  return async (token = "read-only-test-token") => {
    const response = await api.fetch(new Request("http://tend.test/workspaces", { headers: { authorization: `Bearer ${token}` } }));
    return { status: response.status, body: await response.json() };
  };
}

describe("workspaces API", () => {
  it("lists the configured workspaces with their kind and enabled assistant, defaults filled in, never their location or credential", async () => {
    const list = setup([
      workspace("app", { git: { url: "https://git.example/acme/app.git", defaultBranch: "main" }, credentials: { secretRef: { name: "TENDWORKS_AGENT_APP_TOKEN" } }, assistant: { enabled: true } }),
      workspace("docs", { directory: { path: "/srv/workspaces/docs" }, assistant: { enabled: true, profile: "docs-assistant", write: true } }),
      workspace("site", { git: { url: "https://git.example/acme/site.git", defaultBranch: "main" }, assistant: { enabled: false, profile: "docs-assistant" } }),
    ]);

    const { status, body } = await list();

    expect(status).toBe(200);
    expect(body).toEqual({
      items: [
        { name: "app", kind: "git", assistant: { profile: "workspace-assistant", write: false } },
        { name: "docs", kind: "directory", assistant: { profile: "docs-assistant", write: true } },
        { name: "site", kind: "git" },
      ],
    });
  });

  it("needs a token to read", async () => {
    expect((await setup([])("wrong-token")).status).toBe(401);
  });
});
