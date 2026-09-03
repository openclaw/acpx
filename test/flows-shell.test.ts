import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TimeoutError } from "../src/async-control.js";
import {
  formatShellActionSummary,
  renderShellCommand,
  resolveShellActionMaxBufferBytes,
  runShellAction,
  DEFAULT_SHELL_ACTION_MAX_BUFFER_BYTES,
} from "../src/flows/executors/shell.js";

async function waitUntilProcessGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  return false;
}

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

test("resolveShellActionMaxBufferBytes defaults to 1 MiB", () => {
  assert.equal(resolveShellActionMaxBufferBytes(undefined), DEFAULT_SHELL_ACTION_MAX_BUFFER_BYTES);
  assert.equal(resolveShellActionMaxBufferBytes(0), 0);
  assert.equal(resolveShellActionMaxBufferBytes(4096), 4096);
});

test("resolveShellActionMaxBufferBytes rejects non-finite and fractional limits", () => {
  for (const maxBufferBytes of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1.5,
    -1,
    -0.25,
  ]) {
    assert.throws(
      () => resolveShellActionMaxBufferBytes(maxBufferBytes),
      /maxBufferBytes must be a finite non-negative integer/,
    );
  }
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

test("runShellAction rejects non-finite maxBufferBytes before launching", async () => {
  await assert.rejects(
    async () =>
      await runShellAction({
        command: process.execPath,
        args: ["-e", 'process.stdout.write("should-not-run")'],
        maxBufferBytes: Number.POSITIVE_INFINITY,
      }),
    /maxBufferBytes must be a finite non-negative integer/,
  );
});

test("runShellAction rejects fractional maxBufferBytes before launching", async () => {
  await assert.rejects(
    async () =>
      await runShellAction({
        command: process.execPath,
        args: ["-e", 'process.stdout.write("should-not-run")'],
        maxBufferBytes: 12.5,
      }),
    /maxBufferBytes must be a finite non-negative integer/,
  );
});

test("runShellAction caps captured stdout from a flooding command", async () => {
  const chunkSize = 256 * 1024;
  const repeats = 8;
  await assert.rejects(
    async () =>
      await runShellAction({
        command: process.execPath,
        args: [
          "-e",
          `for (let i = 0; i < ${String(repeats)}; i += 1) process.stdout.write("x".repeat(${String(chunkSize)}));`,
        ],
        timeoutMs: 5_000,
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("maxBuffer") &&
      error.message.includes("stdout"),
  );
});

test("runShellAction caps captured stderr from a flooding command", async () => {
  await assert.rejects(
    async () =>
      await runShellAction({
        command: process.execPath,
        args: ["-e", 'process.stderr.write("y".repeat(64 * 1024))'],
        maxBufferBytes: 4_096,
        timeoutMs: 5_000,
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("maxBuffer") &&
      error.message.includes("stderr"),
  );
});

test(
  "runShellAction reaps shell-mode pipeline descendants after overflow",
  { skip: process.platform === "win32" ? "POSIX process-group reap coverage" : false },
  async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-shell-overflow-"));
    const descendantPidPath = path.join(tmp, "descendant.pid");
    const backgroundScript = [
      `require("node:fs").writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("");
    const shellScript = [
      // Background job stays in the shell process group. Overflow cleanup must
      // signal the whole group, not only the shell wrapper PID.
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(backgroundScript)} &`,
      `while [ ! -f ${JSON.stringify(descendantPidPath)} ]; do sleep 0.01; done`,
      // Flood stdout until the executor hits maxBuffer.
      "while true; do printf 'xxxxxxxx'; done",
    ].join("\n");
    try {
      await assert.rejects(
        async () =>
          await runShellAction({
            command: "/bin/sh",
            args: ["-c", shellScript],
            maxBufferBytes: 4_096,
            timeoutMs: 5_000,
          }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("maxBuffer") &&
          error.message.includes("stdout"),
      );

      const descendantPid = Number(await fs.readFile(descendantPidPath, "utf8"));
      assert.ok(
        Number.isInteger(descendantPid) && descendantPid > 0,
        "expected descendant pid file",
      );
      const gone = await waitUntilProcessGone(descendantPid, 3_000);
      if (!gone) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // best-effort cleanup if the assertion fails
        }
        assert.fail(`shell descendant still alive after overflow: ${String(descendantPid)}`);
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  },
);
