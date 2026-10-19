import type { ControlPlane } from "@tendworks/shared";
import createClient from "openapi-fetch";

/** The compose stack's API token: deploy/.env, or the laptop profile's default in deploy/compose.yaml. */
export const API_TOKEN = process.env.TEND_API_TOKEN || "laptop-only-insecure-api-token";

/** The public control plane API of the stack under test, as an operator's client with the API token. */
export const client = createClient<ControlPlane.paths>({
  baseUrl: process.env.TEND_URL ?? "http://localhost:8080",
  headers: { authorization: `Bearer ${API_TOKEN}` },
});

/** The same API without credentials, as anything that only reaches the published port. */
export const anonymous = createClient<ControlPlane.paths>({ baseUrl: process.env.TEND_URL ?? "http://localhost:8080" });
