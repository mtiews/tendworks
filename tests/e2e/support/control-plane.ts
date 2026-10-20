import type { ControlPlane } from "@tendworks/shared";
import createClient from "openapi-fetch";

export const baseUrl = process.env.TEND_URL ?? "http://localhost:8080";

/** The compose stack's API token: deploy/.env, or the laptop profile's default in deploy/compose.yaml. */
export const API_TOKEN = process.env.TEND_API_TOKEN || "laptop-only-insecure-api-token";

/** The compose stack's read-only token, from the same places. */
export const READ_TOKEN = process.env.TEND_API_READ_TOKEN || "laptop-only-insecure-read-token";

/** The public control plane API of the stack under test, as an operator's client with the API token. */
export const client = createClient<ControlPlane.paths>({ baseUrl, headers: { authorization: `Bearer ${API_TOKEN}` } });

/** The same API with the read-only token, as a client that only reads. */
export const reader = createClient<ControlPlane.paths>({ baseUrl, headers: { authorization: `Bearer ${READ_TOKEN}` } });

/** The same API without credentials, as anything that only reaches the published port. */
export const anonymous = createClient<ControlPlane.paths>({ baseUrl });
