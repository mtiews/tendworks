/**
 * Secrets of one consumer handed from one container to another through a file: a
 * short-lived exporter gets the whole environment (in the laptop profile `deploy/.env`)
 * and writes only the consumer's secrets; the bundle that needs them reads the file
 * again at every reference, so it never holds another consumer's secrets and a secret
 * added later needs no restart (ADR 0008).
 *
 * Kept out of the package's browser-safe entry point: it is imported as
 * `@tendworks/platform/secrets-file` and needs Node.js.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { SECRET_PREFIXES, type SecretConsumer } from "./secrets.js";

/** Writes the secrets of `consumer` found in `environment` to `path`, replacing the file as a whole. Never logs a value. */
export function exportSecrets(consumer: SecretConsumer, environment: Record<string, string | undefined>, path: string): string[] {
  const prefix = SECRET_PREFIXES[consumer];
  const secrets = Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[0].startsWith(prefix) && entry[0].length > prefix.length && !!entry[1]),
  );
  // Written next to the file and renamed over it, so a reader never sees half a file.
  const written = `${path}.${process.pid}.tmp`;
  writeFileSync(written, JSON.stringify(secrets), { mode: 0o600 });
  renameSync(written, path);
  return Object.keys(secrets).sort();
}

/** The secrets in `path`; empty while the file does not exist. */
export function readSecretsFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  return JSON.parse(text) as Record<string, string>;
}
