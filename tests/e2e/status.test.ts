import { describe, expect, it } from "vitest";
import { client } from "./support/control-plane.js";

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
