import { createControlPlaneApi, createInMemoryRuns, type HealthProbe } from "@tendworks/control-plane";
import { describe, expect, it } from "vitest";
import { runTend } from "./tend.js";

const probe = (name: string, status: "healthy" | "unhealthy", message?: string): HealthProbe => ({
  name,
  check: async () => (message === undefined ? { status } : { status, message }),
});

async function tend(args: string[], probes: HealthProbe[]) {
  const api = createControlPlaneApi({
    probes,
    configuration: { workflowNames: [], workflow: () => undefined, agentProfiles: [], triggerBindings: [], policies: [], pullRequestIntegrations: [] },
    apiToken: "test-token",
    runs: createInMemoryRuns(),
  });
  let stdout = "";
  let stderr = "";
  const exitCode = await runTend(args, {
    fetch: (request) => api.fetch(request),
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { exitCode, stdout, stderr };
}

describe("tend status", () => {
  it("prints the platform and component health as a table and exits 0 when healthy", async () => {
    const { exitCode, stdout } = await tend(["status"], [probe("store", "healthy"), probe("execution-engine", "healthy")]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^PLATFORM\s+healthy$/m);
    expect(stdout).toMatch(/^COMPONENT\s+STATUS\s+MESSAGE$/m);
    expect(stdout).toMatch(/^store\s+healthy$/m);
    expect(stdout).toMatch(/^execution-engine\s+healthy$/m);
  });

  it("exits 2 and shows the reason when the platform is unhealthy", async () => {
    const { exitCode, stdout } = await tend(
      ["status"],
      [probe("store", "unhealthy", "connection refused"), probe("execution-engine", "healthy")],
    );

    expect(exitCode).toBe(2);
    expect(stdout).toMatch(/^PLATFORM\s+unhealthy$/m);
    expect(stdout).toMatch(/^store\s+unhealthy\s+connection refused$/m);
  });

  it("prints the status document as JSON with -o json", async () => {
    const { exitCode, stdout } = await tend(["status", "-o", "json"], [probe("store", "healthy")]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ status: "healthy", components: [{ name: "store", status: "healthy" }] });
  });

  it("prints the status document as YAML with -o yaml, also when unhealthy", async () => {
    const { exitCode, stdout } = await tend(["status", "-o", "yaml"], [probe("store", "unhealthy", "disk full")]);

    expect(exitCode).toBe(2);
    expect(stdout).toMatch(/^status: unhealthy$/m);
    expect(stdout).toMatch(/^ {2}- name: store\n {4}status: unhealthy\n {4}message: disk full$/m);
  });

  it("exits 1 with a message when the control plane cannot be reached", async () => {
    let stderr = "";
    const exitCode = await runTend(["status", "--url", "http://tend.invalid:8080"], {
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      stdout: () => {},
      stderr: (text) => (stderr += text),
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("cannot reach the control plane at http://tend.invalid:8080");
  });

  it("exits 1 with a message when the answer is not a status document", async () => {
    let stdout = "";
    let stderr = "";
    const exitCode = await runTend(["status"], {
      fetch: async () => new Response("Bad Gateway", { status: 502 }),
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("unexpected answer from the control plane (HTTP 502)");
  });

  it("exits 1 with a message on an unknown output format", async () => {
    const { exitCode, stdout, stderr } = await tend(["status", "-o", "xml"], [probe("store", "healthy")]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("xml");
  });
});
