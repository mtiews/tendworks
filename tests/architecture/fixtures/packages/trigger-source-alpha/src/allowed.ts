import type { Generated } from "../../shared/src/index.js";
import { envelope } from "../../platform/src/index.js";
import type { TriggerSource } from "../../trigger-gateway/src/sources/trigger-source.js";

export const alpha: TriggerSource & { type?: Generated } = { key: envelope };
