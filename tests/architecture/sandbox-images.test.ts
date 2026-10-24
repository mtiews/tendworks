import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The deployment's sandbox images are pinned once, in deploy/compose.yaml: the service that
// builds an image and the worker that fills the pin into sandbox templates read the same
// value. The starter configuration names those images by repository only, so a copy of it
// follows every update of the pin.

const compose = parse(readFileSync(new URL("../../deploy/compose.yaml", import.meta.url), "utf8")) as {
  services: Record<string, { image?: string; profiles?: string[]; environment?: Record<string, string> }>;
};
const built = Object.values(compose.services)
  .filter((service) => service.profiles?.includes("sandbox-images"))
  .map((service) => service.image);
const pinned = (compose.services.worker?.environment?.TEND_SANDBOX_IMAGES ?? "").split(/[\s,]+/).filter(Boolean);

it("pins every sandbox image the deployment builds where the worker reads it", () => {
  expect(built.length).toBeGreaterThan(0);
  expect(pinned).toEqual(built);
});

it("names the deployment's sandbox images by repository alone in the starter configuration", () => {
  const dir = new URL("../../examples/config/sandboxes/", import.meta.url);
  const images = readdirSync(dir).map((file) => (parse(readFileSync(new URL(file, dir), "utf8")) as { spec: { image: string } }).spec.image);
  const repositories = pinned.map((image) => image.replace(/:[^:/]+$/, ""));

  expect(images.length).toBeGreaterThan(0);
  expect(images.every((image) => repositories.includes(image))).toBe(true);
});

// The generic credential helper of images/sandbox-claude-code, run by the host's git the
// way the sandbox's git runs it: configured for the repository's host only.
describe("git credential helper of the Claude Code sandbox image", () => {
  const helper = fileURLToPath(new URL("../../images/sandbox-claude-code/git-credential-tendworks", import.meta.url)).replaceAll("\\", "/");
  const isolated = join(mkdtempSync(join(tmpdir(), "tend-credential-")), "gitconfig");
  writeFileSync(isolated, "");

  function fill(host: string, env: Record<string, string>) {
    const result = spawnSync("git", ["-c", `credential.https://git.example.helper=!sh '${helper}'`, "credential", "fill"], {
      input: `protocol=https\nhost=${host}\npath=acme/app.git\n\n`,
      encoding: "utf8",
      // Nothing of the host's own git configuration or prompts takes part.
      env: { ...process.env, GIT_CONFIG_GLOBAL: isolated, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", ...env },
    });
    return { status: result.status, stdout: result.stdout };
  }

  it("answers with the workspace credential for the repository's host", () => {
    const result = fill("git.example", { TENDWORKS_GIT_USERNAME: "agent", TENDWORKS_GIT_PASSWORD: "app-token-value" }); // betterleaks:allow dummy token of the test

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("username=agent\n");
    expect(result.stdout).toContain("password=app-token-value\n");
  });

  it("uses the default user name for tokens when the workspace names none", () => {
    expect(fill("git.example", { TENDWORKS_GIT_PASSWORD: "app-token-value" }).stdout).toContain("username=x-access-token\n"); // betterleaks:allow dummy token of the test
  });

  it("gives another host nothing, and nothing when the session holds no credential", () => {
    expect(fill("elsewhere.example", { TENDWORKS_GIT_PASSWORD: "app-token-value" }).stdout).not.toContain("app-token-value"); // betterleaks:allow dummy token of the test
    expect(fill("git.example", { TENDWORKS_GIT_PASSWORD: "" }).status).not.toBe(0);
  });
});
