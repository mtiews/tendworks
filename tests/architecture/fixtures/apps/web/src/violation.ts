import { readFileSync } from "node:fs";
import { beta } from "../../../packages/beta/src/index.js";
import { probe } from "../../../packages/health/src/index.js";
import { tend } from "../../cli/src/index.js";

export const violation = [readFileSync, beta, probe, tend];
