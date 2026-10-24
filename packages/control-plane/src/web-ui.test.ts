import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createControlPlaneApi, createInMemoryRuns, emptyConfiguration, type ControlPlaneApiOptions } from "./index.js";

const ENTRY = '<!doctype html><html><head><script type="module" src="/ui/assets/index-abc123.js"></script></head><body><div id="root"></div></body></html>';
const SCRIPT = "console.log('tend');";

/** A built web UI as Vite emits it: the entry page, hashed assets and an unhashed public file. */
function webBuild(): string {
  const root = join(mkdtempSync(join(tmpdir(), "tend-web-")), "dist");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), ENTRY);
  writeFileSync(join(root, "assets", "index-abc123.js"), SCRIPT);
  writeFileSync(join(root, "assets", "index-def456.css"), "body{margin:0}");
  writeFileSync(join(root, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  return root;
}

function setup(options: Partial<ControlPlaneApiOptions> = { webUi: { root: webBuild() } }) {
  const api = createControlPlaneApi({
    probes: [],
    configuration: emptyConfiguration(),
    runs: createInMemoryRuns(),
    apiToken: "s3cret-api-token",
    ...options,
  });
  return (path: string, method = "GET") => api.fetch(new Request(`http://tend.test${path}`, { method }));
}

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

describe("the web UI under /ui/", () => {
  it("redirects the platform's root address to the web UI, without a token", async () => {
    const request = setup();

    for (const path of ["/", "/ui"]) {
      const response = await request(path);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/ui/");
    }
  });

  it("serves the entry page at /ui/, not cached, without a token", async () => {
    const request = setup();

    const response = await request("/ui/");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toBe(ENTRY);
  });

  it("serves the entry page for unknown paths under /ui/, so deep links work", async () => {
    const request = setup();

    for (const path of ["/ui/runs/r-1", "/ui/chats/c-1?tab=2", "/ui/sign-in"]) {
      const response = await request(path);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(ENTRY);
    }
  });

  it("serves hashed assets with their type, cached for good", async () => {
    const request = setup();

    const script = await request("/ui/assets/index-abc123.js");
    const style = await request("/ui/assets/index-def456.css");

    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await script.text()).toBe(SCRIPT);
    expect(style.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  it("serves unhashed files revalidated, and answers 404 for a missing asset instead of the entry page", async () => {
    const request = setup();

    const icon = await request("/ui/favicon.svg");
    const missing = await request("/ui/assets/index-000000.js");

    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(icon.headers.get("cache-control")).toBe("no-cache");
    expect(missing.status).toBe(404);
  });

  it("sends a strict content security policy and refuses framing and sniffing on every answer", async () => {
    const request = setup();

    for (const path of ["/ui/", "/ui/runs", "/ui/assets/index-abc123.js", "/ui/assets/missing.js"]) {
      const response = await request(path);

      expect(response.headers.get("content-security-policy")).toBe(CSP);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("answers HEAD like GET, without a body", async () => {
    const request = setup();

    const response = await request("/ui/assets/index-abc123.js", "HEAD");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toBe("");
  });

  it("never serves a file outside the build", async () => {
    const root = webBuild();
    writeFileSync(join(root, "..", "secret.txt"), "secret");
    const request = setup({ webUi: { root } });

    for (const path of ["/ui/%2e%2e/secret.txt", "/ui/..%2fsecret.txt", "/ui/assets/..%2f..%2fsecret.txt", "/ui/%2e%2e%5csecret.txt"]) {
      const response = await request(path);

      expect(await response.text()).not.toBe("secret");
    }
  });

  it("leaves API paths and their authentication unchanged", async () => {
    const request = setup();

    expect((await request("/runs")).status).toBe(401);
    expect((await request("/status")).status).toBe(200);
  });

  it("answers 404 under /ui/ when the server has no web UI build", async () => {
    const request = setup({});

    const response = await request("/ui/");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ title: "Web UI not available" });
  });
});
