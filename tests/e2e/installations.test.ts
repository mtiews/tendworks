import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ControlPlane } from "@tendworks/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { client } from "./support/control-plane.js";
import { installation, sandboxNetwork, volumeOf } from "./support/installation.js";

type Chat = ControlPlane.components["schemas"]["chat"];

const composeFile = fileURLToPath(new URL("../../deploy/compose.yaml", import.meta.url));
const compose = (...args: string[]) => promisify(execFile)("docker", ["compose", "-f", composeFile, ...args], { timeout: 120_000 });
const docker = async (...args: string[]) => (await promisify(execFile)("docker", args, { timeout: 120_000 })).stdout.trim();
const label = (kind: "container" | "volume", name: string, key: string) =>
  docker(kind, "inspect", "--format", `{{index .${kind === "container" ? "Config.Labels" : "Labels"} "${key}"}}`, name);

/** The harness needs some credential selected; the stack gets it from the environment or deploy/.env. */
function credentialSelected(): boolean {
  if (process.env.TEND_CLAUDE_CODE_CREDENTIAL) return true;
  const env = fileURLToPath(new URL("../../deploy/.env", import.meta.url));
  return existsSync(env) && /^TEND_CLAUDE_CODE_CREDENTIAL=(oauth-token|api-key)\s*$/m.test(readFileSync(env, "utf8"));
}

async function waiting(chatId: string, timeoutMs = 120_000): Promise<Chat> {
  for (const deadline = Date.now() + timeoutMs; ; ) {
    const { data } = await client.GET("/chats/{chatId}", { params: { path: { chatId } } }).catch(() => ({ data: undefined }));
    if (data && data.status !== "working") return data;
    if (Date.now() > deadline) throw new Error(`chat ${chatId} still works on its turn`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = async (kind: "container" | "volume", name: string) =>
  (await docker(kind, "ls", ...(kind === "container" ? ["-a"] : []), "-q", "--filter", `name=^${name}$`)) !== "";
const volumesOf = async (owner: string) => (await docker("volume", "ls", "-q", "--filter", `label=dev.tendworks.owner=${owner}`)).split("\n").filter(Boolean).sort();

// Another installation on the same Docker engine, as the sandbox adapter of a second stack
// would leave it: a sandbox with a session volume, named and labelled after that installation.
const neighbour = `${installation}-neighbour`;
const neighbourId = crypto.randomUUID().replaceAll("-", "");
const neighbourVolume = `${neighbour}-volume-${neighbourId}-session`;
const neighbourSandbox = `${neighbour}-sandbox-${neighbourId}`;

describe.skipIf(!credentialSelected())("installations on one Docker engine", () => {
  beforeAll(async () => {
    const config = JSON.parse(await docker("compose", "-f", composeFile, "--profile", "test-images", "config", "--no-interpolate", "--format", "json"));
    const image = (config.services["sandbox-scripted-acp"] as { image: string }).image;
    const labels = ["--label", `dev.tendworks.installation=${neighbour}`, "--label", `dev.tendworks.owner=${neighbourId}`];
    await docker("volume", "create", ...labels, "--label", `dev.tendworks.volume=${neighbourId}-session`, neighbourVolume);
    await docker(
      "run", "-d", "--name", neighbourSandbox, ...labels, "--label", `dev.tendworks.sandbox=${neighbourId}`,
      "--mount", `type=volume,source=${neighbourVolume},target=/session`, "--entrypoint", "sleep", image, "infinity",
    );
  });

  afterAll(async () => {
    await docker("rm", "-f", "-v", neighbourSandbox).catch(() => {});
    await docker("volume", "rm", "-f", neighbourVolume).catch(() => {});
  });

  it("names a chat's sandbox and volumes after this installation and leaves another installation's alone", { timeout: 300_000 }, async () => {
    const { data: started, response } = await client.POST("/chats", { body: { agent: "scripted-assistant", text: "chat: Hello" } });
    expect(response.status).toBe(201);
    const chatId = started!.id;
    expect(await waiting(chatId)).toMatchObject({ status: "input-required" });

    const [sandbox] = (await docker("ps", "--filter", `label=dev.tendworks.owner=${chatId}`, "--format", "{{.Names}}")).split("\n");
    const sandboxLabels = { installation: await label("container", sandbox!, "dev.tendworks.installation") };
    const network = await docker("inspect", "--format", "{{.HostConfig.NetworkMode}}", sandbox!);
    const volumes = (await docker("volume", "ls", "-q", "--filter", `label=dev.tendworks.owner=${chatId}`)).split("\n").sort();
    const volumeLabels = await Promise.all(volumes.map((volume) => label("volume", volume, "dev.tendworks.installation")));
    await client.POST("/chats/{chatId}/end", { params: { path: { chatId } } });

    expect(sandbox).toMatch(new RegExp(`^${installation}-sandbox-[a-z0-9]+$`));
    expect(sandboxLabels).toEqual({ installation });
    expect(network).toBe(sandboxNetwork);
    expect(volumes).toEqual([volumeOf(`${chatId}-session`), volumeOf(`${chatId}-workspace`)]);
    expect(volumeLabels).toEqual([installation, installation]);
    expect(await docker("inspect", "--format", "{{.State.Running}}", neighbourSandbox)).toBe("true");
    expect(await docker("volume", "ls", "-q", "--filter", `name=${neighbourVolume}`)).toBe(neighbourVolume);
  });

  it("removes this installation's sandboxes and volumes of no live task or open chat after a worker start, and nothing else", { timeout: 600_000 }, async () => {
    // Orphans of this installation: a sandbox with its session volume whose task is unknown,
    // and a workspace volume from before owners were recorded (no owner, no installation label).
    const orphan = crypto.randomUUID().replaceAll("-", "");
    const orphanSandbox = `${installation}-sandbox-${orphan}`;
    const orphanVolume = volumeOf(`${orphan}-session`);
    const legacyVolume = volumeOf(`${crypto.randomUUID()}-workspace`);
    const ours = ["--label", `dev.tendworks.installation=${installation}`, "--label", `dev.tendworks.owner=${orphan}`];
    await docker("volume", "create", ...ours, "--label", `dev.tendworks.volume=${orphan}-session`, orphanVolume);
    await docker("volume", "create", "--label", `dev.tendworks.volume=${legacyVolume.slice(`${installation}-volume-`.length)}`, legacyVolume);
    const image = JSON.parse(await docker("compose", "-f", composeFile, "--profile", "test-images", "config", "--no-interpolate", "--format", "json")).services["sandbox-scripted-acp"].image as string;
    await docker(
      "run", "-d", "--name", orphanSandbox, ...ours, "--label", `dev.tendworks.sandbox=${orphan}`,
      "--mount", `type=volume,source=${orphanVolume},target=/session`, "--entrypoint", "sleep", image, "infinity",
    );
    try {
      // An open chat waiting for a message, and a chat working on a long turn.
      const { data: open } = await client.POST("/chats", { body: { agent: "scripted-assistant", text: "chat: Hello" } });
      expect(await waiting(open!.id)).toMatchObject({ status: "input-required" });
      const { data: working } = await client.POST("/chats", { body: { agent: "scripted-assistant", text: "Write the files" } });
      for (const deadline = Date.now() + 120_000; ; await pause(500)) {
        const entries = (await client.GET("/chats/{chatId}/transcript", { params: { path: { chatId: working!.id } } })).data?.items ?? [];
        if (entries.some((entry) => entry.type === "tool-call")) break;
        if (Date.now() > deadline) throw new Error(`chat ${working!.id} never started its turn`);
      }

      await compose("restart", "worker");
      await compose("up", "-d", "--wait", "server", "worker");
      for (const deadline = Date.now() + 120_000; (await exists("container", orphanSandbox)) || (await exists("volume", orphanVolume)) || (await exists("volume", legacyVolume)); await pause(1_000)) {
        if (Date.now() > deadline) throw new Error("the worker did not remove the orphaned sandbox and volumes");
      }
      const resumed = await waiting(working!.id, 240_000);
      const kept = { open: await volumesOf(open!.id), working: await volumesOf(working!.id) };
      await client.POST("/chats/{chatId}/end", { params: { path: { chatId: open!.id } } });
      await client.POST("/chats/{chatId}/end", { params: { path: { chatId: working!.id } } });

      expect(kept).toEqual({
        open: [volumeOf(`${open!.id}-session`), volumeOf(`${open!.id}-workspace`)],
        working: [volumeOf(`${working!.id}-session`), volumeOf(`${working!.id}-workspace`)],
      });
      expect(resumed).toMatchObject({ status: "input-required", message: expect.stringMatching(/after\.txt\nbefore\.txt$/) });
      expect(await docker("inspect", "--format", "{{.State.Running}}", neighbourSandbox)).toBe("true");
      expect(await docker("volume", "ls", "-q", "--filter", `name=${neighbourVolume}`)).toBe(neighbourVolume);
    } finally {
      await docker("rm", "-f", "-v", orphanSandbox).catch(() => {});
      await docker("volume", "rm", "-f", orphanVolume, legacyVolume).catch(() => {});
    }
  });
});
