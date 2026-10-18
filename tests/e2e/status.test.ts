import type { ControlPlane } from "@tendworks/shared";
import createClient from "openapi-fetch";
import { describe, expect, it } from "vitest";

const client = createClient<ControlPlane.paths>({ baseUrl: process.env.TEND_URL ?? "http://localhost:8080" });

describe("platform status on the compose stack", () => {
  it("reports the platform and all components it depends on as healthy", async () => {
    const { data, response } = await client.GET("/status");

    expect(response.status).toBe(200);
    expect(data?.status).toBe("healthy");
    expect(data?.components.map((c) => [c.name, c.status])).toEqual([
      ["store", "healthy"],
      ["execution-engine", "healthy"],
      ["sandbox-backend", "healthy"],
    ]);
  });
});
