import assert from "node:assert/strict";
import test from "node:test";
import { TimeoutError } from "../src/async-control.js";
import {
  formatShellActionSummary,
  renderShellCommand,
  runShellAction,
} from "../src/flows/executors/shell.js";

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
