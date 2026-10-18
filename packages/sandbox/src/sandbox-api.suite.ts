import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SandboxApi, SandboxTemplate } from "./sandbox-api.js";

export interface SandboxApiSuiteContext {
  api: SandboxApi;
  /** An image present on the backend that provides busybox-style `sh`, `echo`, `cat`, `id`, `pwd`. */
  image: string;
}

/**
 * The behaviour every sandbox backend must show. Runs against the real
 * adapters and the fake, so the fake stays a faithful stand-in.
 */
export function describeSandboxApi(name: string, setup: () => Promise<SandboxApiSuiteContext> | SandboxApiSuiteContext) {
  describe(`sandbox API: ${name}`, () => {
    let context: SandboxApiSuiteContext;
    const created: string[] = [];

    beforeAll(async () => {
      context = await setup();
    });

    afterEach(async () => {
      await Promise.all(created.splice(0).map((id) => context.api.destroy(id)));
    });

    const template = (spec: Partial<SandboxTemplate["spec"]> = {}, templateName = "suite"): SandboxTemplate => ({
      apiVersion: "tendworks.dev/v1",
      kind: "SandboxTemplate",
      metadata: { name: templateName },
      spec: { image: context.image, ...spec },
    });

    const create = async (t: SandboxTemplate = template()) => {
      const sandbox = await context.api.create(t);
      created.push(sandbox.id);
      return sandbox;
    };

    it("creates a running sandbox from a sandbox template", async () => {
      const sandbox = await create(template({}, "node-dev"));

      expect(sandbox).toMatchObject({ template: "node-dev", isolationClass: "container", state: "running" });
      expect(sandbox.id).toMatch(/^[a-z0-9]{1,32}$/);
      expect(Date.parse(sandbox.createdAt)).not.toBeNaN();
    });
  });
}
