import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { TerminalManager } from "../src/acp/terminal-manager.js";

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
    return false;
  }
}

async function readPid(file: string): Promise<number | undefined> {
  try {
    const pid = Number(await fs.readFile(file, "utf8"));
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return undefined;
  }
}

async function assertStopped(pid: number, message: string): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (isRunning(pid) && performance.now() < deadline) {
    await delay(20);
  }
  assert.equal(isRunning(pid), false, message);
}

test(
  "Windows direct terminal release stops detached descendants and preserves siblings",
  { skip: process.platform !== "win32", timeout: 20_000 },
  async (t) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-terminal-descendants-"));
    const pidFile = path.join(cwd, "child.pid");
    const manager = new TerminalManager({ cwd, permissionMode: "approve-all", killGraceMs: 200 });
    const sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const siblingClosed = once(sibling, "close");
    t.after(async () => {
      try {
        await manager.shutdown();
      } finally {
        try {
          const childPid = await readPid(pidFile);
          if (childPid && isRunning(childPid)) {
            process.kill(childPid, "SIGKILL");
            await assertStopped(childPid, "fixture child survived final cleanup");
          }
        } finally {
          sibling.kill("SIGKILL");
          await siblingClosed;
          await fs.rm(cwd, { recursive: true, force: true });
        }
      }
    });
    await once(sibling, "spawn");

    const childCode = [
      "require('node:fs').writeFileSync(process.argv[1], String(process.pid));",
      "setInterval(() => {}, 1000);",
      "process.send('ready');",
    ].join("");
    const rootCode = [
      "const spawn = require('node:child_process').spawn;",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}, ${JSON.stringify(pidFile)}], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
      "child.once('message', () => { child.disconnect(); child.unref(); console.log('ready'); });",
      "setInterval(() => {}, 1000);",
    ].join("");
    const { terminalId } = await manager.createTerminal({
      sessionId: "fixture",
      command: process.execPath,
      args: ["-e", rootCode],
    });
    const params = { sessionId: "fixture", terminalId };
    const readyDeadline = performance.now() + 5_000;
    while (!(await manager.terminalOutput(params)).output.includes("ready")) {
      assert.ok(performance.now() < readyDeadline, "detached child did not become ready");
      await delay(20);
    }
    const childPid = await readPid(pidFile);
    assert.ok(childPid && isRunning(childPid));
    assert.ok(sibling.pid && isRunning(sibling.pid));

    await manager.releaseTerminal(params);

    await assertStopped(childPid, "detached descendant survived terminal release");
    assert.ok(isRunning(sibling.pid), "unrelated sibling was terminated");
    await assert.rejects(manager.terminalOutput(params), /Unknown terminal/u);
  },
);
