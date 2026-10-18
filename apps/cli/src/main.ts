#!/usr/bin/env node
import { runTend } from "./tend.js";

process.exitCode = await runTend(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
