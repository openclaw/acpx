import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runShellAction, runShellCommand } from "../src/flows/executors/shell.js";
import { compute } from "../src/flows/runtime.js";

test("shell input and deadlines are validated before spawning", async (t) => {
  let spawned = false;
  t.mock.method(childProcess, "spawn", () => {
    spawned = true;
    throw new Error("invalid execution reached spawn");
  });
  syncBuiltinESMExports();
  try {
    for (const stdin of [5, {}, null]) {
      await assert.rejects(
        runShellCommand({ command: "cat", stdin: stdin as unknown as string }, {}),
        /stdin must be a string/,
      );
    }
    for (const timeoutMs of [2_147_483_648, Infinity, Number.NaN]) {
      await assert.rejects(
        runShellCommand({ command: "cat", timeoutMs }, {}),
        /timeoutMs must be a finite number no greater than 2147483647/,
      );
    }
    assert.equal(spawned, false);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("flow nodes reject deadlines beyond the native timer limit", () => {
  assert.throws(() => compute({ timeoutMs: 2_147_483_648, run: () => "done" }), /timeoutMs/);
  assert.equal(compute({ timeoutMs: 2_147_483_647, run: () => "done" }).timeoutMs, 2_147_483_647);
});

test("shell actions capture output delivered between exit and close", async (t) => {
  const child = new childProcess.ChildProcess();
  const stdout = Object.assign(new PassThrough(), { unref: () => {} });
  const stderr = Object.assign(new PassThrough(), { unref: () => {} });
  Object.assign(child, { stdin: new PassThrough(), stdout, stderr });
  t.mock.method(childProcess, "spawn", () => child);
  syncBuiltinESMExports();
  try {
    const result = runShellAction({ command: "synthetic-child" });
    child.emit("exit", 0, null);
    stdout.write("last stdout");
    stderr.write("last stderr");
    stdout.end();
    stderr.end();
    child.emit("close", 0, null);
    assert.equal((await result).combinedOutput, "last stdoutlast stderr");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    child.stdin?.destroy();
    stdout.destroy();
    stderr.destroy();
  }
});
