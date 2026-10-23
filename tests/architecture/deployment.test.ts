import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Safe and unattended defaults of the compose stack (deploy/compose.yaml) and the
// variables an operator sets in deploy/.env (deploy/.env.example).

const read = (path: string) => readFileSync(new URL(`../../deploy/${path}`, import.meta.url), "utf8");
const composeText = read("compose.yaml");
const compose = parse(composeText) as {
  services: Record<string, { profiles?: string[]; restart?: string; ports?: string[]; environment?: Record<string, unknown>; command?: string[] }>;
};
const services = Object.entries(compose.services);
/** Services `up` starts without a profile, plus those of the given profiles. */
const started = (...profiles: string[]) => services.filter(([, service]) => !service.profiles || service.profiles.some((profile) => profiles.includes(profile)));

describe("the compose stack", () => {
  it("has no default API or read-only token, so the server refuses to start until they are set", () => {
    for (const [name, service] of services) {
      for (const variable of ["TEND_API_TOKEN", "TEND_API_READ_TOKEN"]) {
        const value = service.environment?.[variable];
        if (value !== undefined) expect(value, `${name}: ${variable}`).toBe(`\${${variable}:-}`);
      }
    }
  });

  it("restarts every long-running service by itself, also after a host reboot", () => {
    for (const [name, service] of started("debug")) expect(service.restart, name).toBe("unless-stopped");
  });

  it("publishes only the API without a profile; the workflow engine's UI only with the profile debug", () => {
    const published = (profiles: string[]) => started(...profiles).filter(([, service]) => service.ports?.length);

    expect(published([]).map(([name]) => name)).toEqual(["server"]);
    expect(Object.fromEntries(published(["debug"]).map(([name, service]) => [name, service.ports]))).toEqual({
      server: ["127.0.0.1:${TEND_PORT:-8080}:8080"],
      "temporal-ui": ["127.0.0.1:${TEND_ENGINE_UI_PORT:-8233}:8080"],
    });
    expect(compose.services.temporal?.command).toContain("--headless");
  });
});

describe("deploy/.env.example", () => {
  const example = read(".env.example");
  const listed = new Set([...example.matchAll(/^#? ?([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]));

  it("lists every variable the compose stack reads", () => {
    const read = new Set([...composeText.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]));

    expect([...read].filter((variable) => !listed.has(variable))).toEqual([]);
  });

  it("lists the compose project name, which names the installation", () => {
    expect(listed).toContain("COMPOSE_PROJECT_NAME");
  });

  it("leaves both tokens empty for scripts/setup-env.sh to fill in", () => {
    expect(example).toMatch(/^TEND_API_TOKEN=$/m);
    expect(example).toMatch(/^TEND_API_READ_TOKEN=$/m);
  });
});
