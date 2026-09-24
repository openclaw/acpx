import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createAcpRuntime, createAgentRegistry, type AcpRuntimeTurn } from "../src/runtime.js";
import { InMemorySessionStore, withTempDir } from "./runtime-test-helpers.js";

const peer = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

async function outputText(turn: AcpRuntimeTurn): Promise<string> {
  let text = "";
  for await (const event of turn.events) {
    if (event.type === "text_delta" && (event.stream ?? "output") === "output") {
      text += event.text;
    }
  }
  return text;
}

test("in-process steer turns queue behind the active prompt instead of entering it", async (t) => {
  await withTempDir("acpx-steer-mode-", async (directory) => {
    const pids: number[] = [];
    const runtime = createAcpRuntime({
      cwd: directory,
      sessionStore: new InMemorySessionStore(),
      agentRegistry: createAgentRegistry({
        overrides: { fixture: [process.execPath, peer] },
      }),
      permissionMode: "deny-all",
      processLifecycle: {
        onSpawned: async ({ pid }: { pid: number }) => {
          pids.push(pid);
        },
      },
    });
    t.after(async () => {
      await runtime.shutdown();
      for (const pid of pids) {
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }
    });
    const handle = await runtime.ensureSession({
      sessionKey: "steer",
      agent: "fixture",
      mode: "persistent",
    });
    const release = path.join(directory, "release");

    const active = runtime.startTurn({
      handle,
      mode: "prompt",
      requestId: "active",
      text: `stream-wait-file ${release}`,
    });
    const activeText = outputText(active);
    await active.promptStarted;

    const steer = runtime.startTurn({
      handle,
      mode: "steer",
      requestId: "steer",
      text: "echo steered",
    });
    let steerStarted = false;
    void steer.promptStarted.then(() => {
      steerStarted = true;
    });
    const steerText = outputText(steer);

    await delay(200);
    assert.equal(
      steerStarted,
      false,
      "a steer turn must not be dispatched during the active prompt",
    );

    await fs.writeFile(release, "release");
    assert.deepEqual(await active.result, { status: "completed", stopReason: "end_turn" });
    assert.doesNotMatch(await activeText, /steered/u);

    await steer.promptStarted;
    assert.deepEqual(await steer.result, { status: "completed", stopReason: "end_turn" });
    assert.match(await steerText, /steered/u);
  });
});
