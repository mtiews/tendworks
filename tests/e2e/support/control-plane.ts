import { existsSync, readFileSync } from "node:fs";
import type { ControlPlane } from "@tendworks/shared";
import createClient from "openapi-fetch";

export const baseUrl = process.env.TEND_URL ?? "http://localhost:8080";

/**
 * A token of the compose stack, as compose reads it: from the environment, or else from
 * deploy/.env, which scripts/setup-env.sh creates. The stack has no default tokens.
 */
function stackToken(name: string): string {
  const env = new URL("../../../deploy/.env", import.meta.url);
  const value = process.env[name] || (existsSync(env) ? new RegExp(`^${name}=(.*)$`, "m").exec(readFileSync(env, "utf8"))?.[1]?.trim() : undefined);
  if (!value) throw new Error(`${name} is set neither in the environment nor in deploy/.env; create deploy/.env with scripts/setup-env.sh`);
  return value;
}

/** The compose stack's API token. */
export const API_TOKEN = stackToken("TEND_API_TOKEN");

/** The compose stack's read-only token. */
export const READ_TOKEN = stackToken("TEND_API_READ_TOKEN");

/** The public control plane API of the stack under test, as an operator's client with the API token. */
export const client = createClient<ControlPlane.paths>({ baseUrl, headers: { authorization: `Bearer ${API_TOKEN}` } });

/** The same API with the read-only token, as a client that only reads. */
export const reader = createClient<ControlPlane.paths>({ baseUrl, headers: { authorization: `Bearer ${READ_TOKEN}` } });

/** The same API without credentials, as anything that only reaches the published port. */
export const anonymous = createClient<ControlPlane.paths>({ baseUrl });
