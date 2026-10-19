#!/usr/bin/env node
import { createInterface } from "node:readline";
import { runTend } from "./tend.js";

process.exitCode = await runTend(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  // Opened only by interactive commands, so the others do not wait for standard input.
  lines: () => createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator](),
});
