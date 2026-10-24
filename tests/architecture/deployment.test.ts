import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Safe and unattended defaults of the compose stack (deploy/compose.yaml) and the
// variables an operator sets in deploy/.env (deploy/.env.example).

const read = (path: string) => readFileSync(new URL(`../../deploy/${path}`, import.meta.url), "utf8");
const composeText = read("compose.yaml");
const compose = parse(composeText) as {
  services: Record<
    string,
    {
      image?: string;
      profiles?: string[];
      restart?: string;
      ports?: string[];
      environment?: Record<string, unknown>;
      command?: string[];
      networks?: string[];
      volumes?: (string | { type: string; source: string; target: string; read_only?: boolean })[];
      depends_on?: Record<string, { condition: string }>;
    }
  >;
  networks?: Record<string, { internal?: boolean } | null>;
};
const services = Object.entries(compose.services);
/** Services that run once and end, which others wait for (e.g. the agent secrets exporter). */
const oneShot = new Set(
  services.flatMap(([, service]) => Object.entries(service.depends_on ?? {}).filter(([, { condition }]) => condition === "service_completed_successfully").map(([name]) => name)),
);
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

  it("has no default store password and puts none into a connection URL, so server and worker refuse to start until it is set", () => {
    const { postgres, server, worker } = compose.services;

    expect(postgres?.environment?.POSTGRES_PASSWORD).toBe("${TEND_POSTGRES_PASSWORD:-}");
    for (const [name, service] of Object.entries({ server, worker })) {
      expect(service?.environment?.TEND_POSTGRES_PASSWORD, name).toBe("${TEND_POSTGRES_PASSWORD:-}");
      expect(new URL(String(service?.environment?.TEND_DATABASE_URL)).password, name).toBe("");
    }
    expect(composeText).not.toMatch(/TEND_POSTGRES_PASSWORD:-[^}]/);
  });

  it("names the store's user and database as the backup and restore scripts do", () => {
    const scripts = readFileSync(new URL("../../scripts/lib/stack.sh", import.meta.url), "utf8");
    const named = (variable: string) => new RegExp(`^${variable}=(.*)$`, "m").exec(scripts)?.[1];

    expect({ user: named("STORE_USER"), database: named("STORE_DATABASE") }).toEqual({
      user: compose.services.postgres?.environment?.POSTGRES_USER,
      database: compose.services.postgres?.environment?.POSTGRES_DB,
    });
  });

  it("restarts every long-running service by itself, also after a host reboot", () => {
    for (const [name, service] of started("debug").filter(([name]) => !oneShot.has(name))) expect(service.restart, name).toBe("unless-stopped");
  });

  it("never restarts a service that runs once, which would run it again and again", () => {
    expect(oneShot.size).toBeGreaterThan(0);
    for (const name of oneShot) expect(compose.services[name]?.restart ?? "no", name).toBe("no");
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

  it("lets sandboxes reach the platform MCP server only through the gateway, on an internal network of its own", () => {
    const { worker, "mcp-gateway": gateway } = compose.services;
    const url = new URL(/:-([^}]*)\}$/.exec(String(worker?.environment?.TEND_PLATFORM_MCP_URL))![1]!);
    const onNetwork = services.filter(([, service]) => service.networks?.includes("platform-mcp")).map(([name]) => name);

    expect(url.hostname).toBe("mcp-gateway");
    expect(url.pathname).toBe("/mcp");
    expect(worker?.environment?.TEND_PLATFORM_MCP_NETWORK).toBe("${COMPOSE_PROJECT_NAME}_platform-mcp");
    expect(onNetwork).toEqual(["mcp-gateway"]);
    expect(compose.networks?.["platform-mcp"]?.internal).toBe(true);
    expect(gateway?.image).toMatch(/:\d+\.\d+\.\d+/);
  });

  it("mounts the workspace root only into server and worker, read-only at the path it has on the host, and allows none by default", () => {
    const withRoot = services.filter(([, service]) => service.environment?.TEND_WORKSPACE_ROOTS !== undefined).map(([name]) => name);
    const mounted = services
      .filter(([, service]) => (service.volumes ?? []).some((volume) => typeof volume === "object" && String(volume.source).includes("TEND_WORKSPACE_ROOTS")))
      .map(([name]) => name);

    expect(withRoot.sort()).toEqual(["server", "worker"]);
    expect(mounted.sort()).toEqual(["server", "worker"]);
    for (const name of mounted) {
      const mount = compose.services[name]!.volumes!.find((volume) => typeof volume === "object" && String(volume.source).includes("TEND_WORKSPACE_ROOTS"));
      expect(mount, name).toEqual({
        type: "bind",
        source: "${TEND_WORKSPACE_ROOTS:-./no-workspace-roots}",
        target: "${TEND_WORKSPACE_ROOTS:-/no-workspace-roots}",
        read_only: true,
      });
      expect(compose.services[name]!.environment!.TEND_WORKSPACE_ROOTS, name).toBe("${TEND_WORKSPACE_ROOTS:-}");
    }
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
