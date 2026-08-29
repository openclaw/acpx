import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InterruptedError, TimeoutError } from "../src/async-control.js";
import {
  formatShellActionSummary,
  renderShellCommand,
  runShellAction,
} from "../src/flows/executors/shell.js";
import { isProcessAlive } from "../src/process-liveness.js";

test("renderShellCommand quotes arguments consistently", () => {
  assert.equal(renderShellCommand("echo", ["hello", "two words"]), 'echo "hello" "two words"');
});

test("formatShellActionSummary prefixes rendered commands", () => {
  assert.equal(
    formatShellActionSummary({
      command: "git",
      args: ["status", "--short"],
    }),
    'shell: git "status" "--short"',
  );
});

test("runShellAction captures stdout and stderr", async () => {
  const result = await runShellAction({
    command: process.execPath,
    args: ["-e", 'process.stdout.write("ok"); process.stderr.write("warn");'],
  });

  assert.equal(result.stdout, "ok");
  assert.equal(result.stderr, "warn");
  assert.equal(result.combinedOutput, "okwarn");
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
});

test("runShellAction allows non-zero exits when requested", async () => {
  const result = await runShellAction({
    command: process.execPath,
    args: ["-e", "process.exit(3)"],
    allowNonZeroExit: true,
  });

  assert.equal(result.exitCode, 3);
});

test("runShellAction rejects non-zero exits by default", async () => {
  await assert.rejects(
    async () =>
      await runShellAction({
        command: process.execPath,
        args: ["-e", 'process.stderr.write("boom"); process.exit(2)'],
      }),
    /Shell action failed/,
  );
});

test("runShellAction times out long-running commands", async () => {
  await assert.rejects(
    async () =>
      await runShellAction({
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10_000)"],
        timeoutMs: 50,
      }),
    (error: unknown) => error instanceof TimeoutError,
  );
});

test("runShellAction rejects commands terminated by signal", async () => {
  await assert.rejects(
    async () =>
      await runShellAction({
        command: "/bin/sh",
        args: ["-c", 'kill -TERM "$$"'],
      }),
    /signal SIGTERM/,
  );
});

test("runShellAction already-aborted signal does not spawn a child", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    async () =>
      await runShellAction(
        {
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
        { signal: controller.signal },
      ),
    InterruptedError,
  );
});

test("runShellAction abort kills the child process", async () => {
  const pidDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-shell-abort-"));
  const pidPath = path.join(pidDir, "pid");
  const controller = new AbortController();
  let pid: number | undefined;
  const run = runShellAction(
    {
      command: process.execPath,
      args: ["-e", writePidAndKeepAliveScript(pidPath)],
    },
    { signal: controller.signal },
  );

  try {
    pid = await waitForPidFile(pidPath, 2_000);
    assert.equal(isProcessAlive(pid), true);
    const rejected = assert.rejects(async () => await run, InterruptedError);
    controller.abort();
    assert.equal(await waitUntilDead(pid, 1_500), true);
    await rejected;
  } finally {
    forceKill(pid);
    await run.catch(() => undefined);
    await fs.rm(pidDir, { recursive: true, force: true });
  }
});

function writePidAndKeepAliveScript(pidPath: string): string {
  return `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 60_000);`;
}

async function waitForPidFile(pidPath: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = Number(await fs.readFile(pidPath, "utf8"));
      if (Number.isInteger(value) && value > 0) {
        return value;
      }
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for pid file ${pidPath}`);
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isProcessAlive(pid);
}

function forceKill(pid: number | undefined): void {
  if (!pid || !isProcessAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}
