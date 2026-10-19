import type { Generated } from "../../shared/src/index.js";
import { probe } from "../../health/src/index.js";
import { envelope } from "../../platform/src/index.js";

export const allowed: Generated = probe;
export const event = envelope;
