import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ControlPlane } from "@tendworks/shared";
import { describe, expect, it } from "vitest";
import { client } from "./support/control-plane.js";

type Chat = ControlPlane.components["schemas"]["chat"];

// An operator adds a secret for an agent with one TENDWORKS_AGENT_* line in deploy/.env
// and `up -d`; deploy/compose.yaml names no agent secret. The fixture profile
// scripted-secret-assistant references TENDWORKS_AGENT_E2E_SECRET, which this test adds
// to deploy/.env and removes again afterwards.

const composeFile = fileURLToPath(new URL("../../deploy/compose.yaml", import.meta.url));
const envFile = fileURLToPath(new URL("../../deploy/.env", import.meta.url));
const compose = (...args: string[]) => promisify(execFile)("docker", ["compose", "-f", composeFile, ...args], { timeout: 300_000 });
/** What an operator runs after changing deploy/.env; the stack runs on the same settings, so only what changed is recreated. */
const up = () => compose("up", "-d", "--wait");

/** The harness needs some credential selected; the stack gets it from the environment or deploy/.env. */
function credentialSelected(): boolean {
  if (process.env.TEND_CLAUDE_CODE_CREDENTIAL) return true;
  return existsSync(envFile) && /^TEND_CLAUDE_CODE_CREDENTIAL=(oauth-token|api-key)\s*$/m.test(readFileSync(envFile, "utf8"));
}

async function answer(text: string): Promise<Chat> {
  const { data: started, response } = await client.POST("/chats", { body: { agent: "scripted-secret-assistant", text } });
  if (!started) throw new Error(`POST /chats answered HTTP ${response.status}`);
  const of = { params: { path: { chatId: started.id } } };
  try {
    for (const deadline = Date.now() + 120_000; ; ) {
      const { data } = await client.GET("/chats/{chatId}", of);
      if (data && data.status !== "working") return data;
      if (Date.now() > deadline) throw new Error(`chat ${started.id} still works on its turn`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    await client.POST("/chats/{chatId}/end", of);
  }
}

describe("agent secrets", () => {
  it.skipIf(!credentialSelected() || !existsSync(envFile))(
    "a TENDWORKS_AGENT_* line added to deploy/.env reaches the sandbox of the profile that references it, without a compose edit",
    { timeout: 600_000 },
    async () => {
      const original = readFileSync(envFile, "utf8");
      const secret = randomBytes(16).toString("hex");
      try {
        writeFileSync(envFile, `${original}${original.endsWith("\n") ? "" : "\n"}TENDWORKS_AGENT_E2E_SECRET=${secret}\n`);
        await up();

        const chat = await answer("secret:");

        expect(chat).toMatchObject({ status: "input-required", message: `secret digest ${createHash("sha256").update(secret).digest("hex")}` });
      } finally {
        writeFileSync(envFile, original);
        await up();
      }
    },
  );
});
