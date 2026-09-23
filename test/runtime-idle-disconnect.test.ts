import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createAcpRuntime, createAgentRegistry } from "../src/runtime.js";
import { InMemorySessionStore } from "./runtime-test-helpers.js";

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, message);
    await delay(20);
  }
}

for (const mode of ["idle-eof", "idle-limit-error", "idle-exit"]) {
  test(`public runtime retires idle agent and delegated terminal after ${mode}`, async (t) => {
    if (mode === "idle-eof" && process.platform === "win32") {
      t.skip("The live-agent stdout fixture does not produce EOF on Windows");
      return;
    }
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-idle-disconnect-"));
    const terminalPidFile = path.join(cwd, "terminal.pid");
    const triggerFile = path.join(cwd, "disconnect");
    const launches: number[] = [];
    const exits: number[] = [];
    let terminalPid: number | undefined;
    const previousLimit = process.env.ACPX_MAX_ACP_MESSAGE_BYTES;
    process.env.ACPX_MAX_ACP_MESSAGE_BYTES = "1024";
    const runtime = createAcpRuntime({
      cwd,
      sessionStore: new InMemorySessionStore(),
      agentRegistry: createAgentRegistry({
        overrides: {
          fixture: [
            process.execPath,
            path.resolve("dist-test/test/fixtures/idle-disconnect-agent.js"),
            mode,
            terminalPidFile,
            triggerFile,
          ],
        },
      }),
      permissionMode: "approve-all",
      timeoutMs: 5_000,
      processLifecycle: {
        onSpawned: ({ pid }) => {
          launches.push(pid);
        },
        onExit: ({ pid }) => {
          exits.push(pid);
        },
      },
    });
    t.after(async () => {
      await runtime.shutdown();
      for (const pid of [...launches, ...(terminalPid ? [terminalPid] : [])]) {
        if (isRunning(pid)) {
          process.kill(pid, "SIGKILL");
        }
      }
      if (previousLimit === undefined) {
        delete process.env.ACPX_MAX_ACP_MESSAGE_BYTES;
      } else {
        process.env.ACPX_MAX_ACP_MESSAGE_BYTES = previousLimit;
      }
      await fs.rm(cwd, { recursive: true, force: true });
    });
    const input = { sessionKey: "idle-session", agent: "fixture", mode: "persistent" as const };
    const handle = await runtime.ensureSession(input);
    await waitFor(
      async () =>
        Boolean(await fs.stat(`${triggerFile}.ready`).catch(() => undefined)) &&
        Boolean(await fs.stat(terminalPidFile).catch(() => undefined)),
      "agent did not create its delegated terminal",
    );
    terminalPid = Number(await fs.readFile(terminalPidFile, "utf8"));
    assert.ok(isRunning(launches[0]));
    assert.ok(Number.isSafeInteger(terminalPid) && isRunning(terminalPid));
    await fs.writeFile(triggerFile, "disconnect");

    // No turn or explicit close runs here: transport failure owns retirement.
    await waitFor(
      () => exits.includes(launches[0]),
      "idle agent exit was not observed after trigger",
    );
    await waitFor(() => !isRunning(terminalPid), "delegated terminal survived its agent");
    assert.equal(isRunning(launches[0]), false);
    assert.deepEqual(exits, [launches[0]]);

    await fs.rm(triggerFile);
    const resumed = await runtime.ensureSession(input);
    assert.equal(resumed.backendSessionId, handle.backendSessionId);
    const turn = runtime.startTurn({
      handle: resumed,
      text: "resume after disconnect",
      mode: "prompt",
      requestId: "resumed-turn",
    });
    for await (const event of turn.events) {
      void event;
    }
    assert.equal((await turn.result).status, "completed");
    assert.equal(launches.length, 2);
    assert.ok(isRunning(launches[1]), "retiring launch closed its replacement");
    await runtime.close({ handle: resumed, reason: "regression complete" });
    assert.equal(isRunning(launches[1]), false);
  });
}
