// Points git at the versioned hooks in .githooks. Runs on `pnpm install`; does nothing
// outside a git checkout (e.g. inside the Docker build).
import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
} catch {
  process.exit(0);
}
execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "inherit" });
