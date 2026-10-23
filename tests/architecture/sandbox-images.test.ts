import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
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
