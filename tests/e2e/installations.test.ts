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
    const { data } = await client.GET("/chats/{chatId}", { params: { path: { chatId } } });
    if (data && data.status !== "working") return data;
    if (Date.now() > deadline) throw new Error(`chat ${chatId} still works on its turn`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

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
});
