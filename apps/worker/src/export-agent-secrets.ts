// Run once before the worker (compose service agent-secrets): writes the agent secrets
// (TENDWORKS_AGENT_*) of its environment, which compose fills from deploy/.env, to the file
// the worker reads them from. Platform secrets stay behind (ADR 0008). Never logs a value.
import { exportSecrets } from "@tendworks/platform/secrets-file";

const path = process.env.TEND_AGENT_SECRETS_FILE;
if (!path) {
  console.error("missing environment variable TEND_AGENT_SECRETS_FILE");
  process.exit(1);
}
const names = exportSecrets("agent", process.env, path);
console.log(`agent secrets: ${names.length === 0 ? "none" : names.join(", ")}`);
