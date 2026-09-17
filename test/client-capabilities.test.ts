import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AnyMessage } from "@agentclientprotocol/sdk";
import { AcpClient } from "../src/acp/client.js";
import { withTempDir } from "./runtime-test-helpers.js";

const agent = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

for (const enabled of [false, true]) {
  test(`capabilities stay ${enabled} until the connection is replaced`, async () => {
    await withTempDir("acpx-capabilities-", async (cwd) => {
      const file = path.join(cwd, "input.txt");
      await fs.writeFile(file, "capability input");
      const messages: AnyMessage[] = [];
      let output = "";
      const client = new AcpClient({
        agentCommand: process.execPath,
        agentArgv: [process.execPath, agent],
        cwd,
        permissionMode: "approve-all",
        fs: enabled,
        terminal: enabled,
        onAcpMessage: (_direction, message) => {
          messages.push(message);
        },
        onSessionUpdate: ({ update }) => {
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            output += update.content.text;
          }
        },
      });
      try {
        await client.start();
        client.updateRuntimeOptions({ fs: !enabled, terminal: !enabled });
        for (const allowed of [enabled, !enabled]) {
          const session = await client.createSession();
          for (const [prompt, expectedOutput] of [
            [`read ${file}`, "capability input"],
            [
              `terminal ${JSON.stringify(process.execPath)} -e "process.stdout.write('capability output')"`,
              "capability output",
            ],
          ]) {
            messages.length = 0;
            output = "";
            assert.equal((await client.prompt(session.sessionId, prompt)).stopReason, "end_turn");
            assert.equal(output.includes(expectedOutput), allowed, output);
            assert.equal(
              messages.some((message) => "error" in message && message.error.code === -32601),
              !allowed,
              JSON.stringify(messages),
            );
          }
          await client.close();
          if (allowed === enabled) {
            await client.start();
          }
        }
      } finally {
        await client.close();
      }
    });
  });
}
