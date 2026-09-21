import assert from "node:assert/strict";
import childProcess, { ChildProcess, type ExecFileOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { ProcessDescendants } from "../src/acp/process-descendants.js";

const rootPid = 2_000_001;
const childPid = 2_000_002;
const grandchildPid = 2_000_003;
const olderBirth = "2026-09-21T10:00:00.0000000Z";
const rootBirth = "2026-09-21T10:00:01.0000000Z";
const childBirth = "2026-09-21T10:00:02.0000000Z";
const laterBirth = "2026-09-21T10:00:03.0000000Z";

function windowsProcesses(t: TestContext) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  const systemRoot = process.env.SystemRoot;
  process.env.SystemRoot = "C:\\Windows";
  const root = Object.assign(new ChildProcess(), { pid: rootPid });
  const descendants = new ProcessDescendants(root);
  const signals: Array<{ pid: number; signal?: string | number }> = [];
  const queries: Array<{ command: string; args: readonly string[] }> = [];
  const helperSignals: Array<string | number | undefined> = [];
  const snapshot = { output: "", error: null as Error | null, hang: false };
  const helper = new ChildProcess();
  t.mock.method(helper, "kill", (signal?: string | number) => {
    helperSignals.push(signal);
    return true;
  });
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    signals.push({ pid, signal });
    return true;
  });
  t.mock.method(childProcess, "execFile", ((
    command: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    queries.push({ command, args });
    assert.equal(options.windowsHide, true);
    if (!snapshot.hang) {
      queueMicrotask(() => callback(snapshot.error, snapshot.output, ""));
    }
    return helper;
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  t.after(() => {
    descendants.retire();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (platform) {
      Object.defineProperty(process, "platform", platform);
    }
    if (systemRoot === undefined) {
      delete process.env.SystemRoot;
    } else {
      process.env.SystemRoot = systemRoot;
    }
  });
  return { descendants, root, signals, queries, snapshot, helperSignals };
}

function processRow(pid: number, parent: number, birth: string): string {
  return `${pid} ${parent} 0 S ${birth}\r\n`;
}

test("Windows descendants include nested processes and survive bridge exit", async (t) => {
  const fixture = windowsProcesses(t);
  fixture.snapshot.output =
    processRow(grandchildPid, childPid, laterBirth) +
    processRow(rootPid, process.pid, rootBirth) +
    processRow(childPid, rootPid, childBirth) +
    processRow(childPid + 10, process.pid, childBirth);
  assert.equal(await fixture.descendants.capture(), true);
  assert.equal(
    fixture.queries[0]?.command,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.deepEqual(fixture.queries[0]?.args.slice(0, 4), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
  ]);

  Object.assign(fixture.root, { exitCode: 0 });
  fixture.snapshot.output =
    processRow(childPid, rootPid, childBirth) + processRow(grandchildPid, childPid, laterBirth);
  await fixture.descendants.signal("SIGTERM", 1_000);
  assert.deepEqual(fixture.signals, [
    { pid: childPid, signal: "SIGTERM" },
    { pid: grandchildPid, signal: "SIGTERM" },
  ]);
  fixture.snapshot.output = "";
  assert.equal(await fixture.descendants.waitForExit(1_000), true);
});

test("Windows descendants reject stale ancestry from reused parent PIDs", async (t) => {
  const fixture = windowsProcesses(t);
  fixture.snapshot.output =
    processRow(rootPid, process.pid, rootBirth) +
    processRow(childPid, rootPid, childBirth) +
    processRow(grandchildPid, childPid, olderBirth) +
    processRow(childPid + 10, rootPid, olderBirth);
  await fixture.descendants.signal("SIGTERM", 1_000);
  assert.deepEqual(fixture.signals, [{ pid: childPid, signal: "SIGTERM" }]);
});

test("Windows descendants do not rediscover a reused bridge PID", async (t) => {
  const fixture = windowsProcesses(t);
  fixture.snapshot.output = processRow(rootPid, process.pid, rootBirth);
  await fixture.descendants.capture();
  fixture.snapshot.output =
    processRow(rootPid, process.pid, childBirth) + processRow(childPid, rootPid, laterBirth);
  await fixture.descendants.signal("SIGTERM", 1_000);
  assert.deepEqual(fixture.signals, []);
});

test("Windows descendants retire reused and disappeared identities", async (t) => {
  const fixture = windowsProcesses(t);
  fixture.snapshot.output =
    processRow(rootPid, process.pid, rootBirth) + processRow(childPid, rootPid, childBirth);
  await fixture.descendants.capture();
  Object.assign(fixture.root, { exitCode: 0 });
  fixture.snapshot.output = processRow(childPid, rootPid, laterBirth);
  await fixture.descendants.signal("SIGTERM", 1_000);
  fixture.snapshot.output = processRow(childPid, rootPid, childBirth);
  await fixture.descendants.signal("SIGTERM", 1_000);
  assert.deepEqual(fixture.signals, []);
});

test("Windows snapshot failure never signals saved identities", async (t) => {
  const fixture = windowsProcesses(t);
  fixture.snapshot.output =
    processRow(rootPid, process.pid, rootBirth) + processRow(childPid, rootPid, childBirth);
  await fixture.descendants.capture();
  fixture.snapshot.error = new Error("CIM query failed");
  await fixture.descendants.signal("SIGTERM", 1_000);
  assert.deepEqual(fixture.signals, []);
  assert.equal(await fixture.descendants.waitForExit(1_000), false);
});

test("Windows snapshot helpers obey the caller's timeout", async (t) => {
  const fixture = windowsProcesses(t);
  fixture.snapshot.hang = true;
  assert.equal(await fixture.descendants.capture(10), false);
  assert.deepEqual(fixture.helperSignals, ["SIGKILL"]);
  assert.deepEqual(fixture.signals, []);
});

test("Windows snapshots do not search the project when SystemRoot is unavailable", async (t) => {
  const fixture = windowsProcesses(t);
  delete process.env.SystemRoot;
  assert.equal(await fixture.descendants.capture(), false);
  process.env.SystemRoot = "relative";
  assert.equal(await fixture.descendants.capture(), false);
  assert.equal(fixture.queries.length, 0);
});

test("retired Windows descendants do not launch another snapshot", async (t) => {
  const fixture = windowsProcesses(t);
  fixture.descendants.retire();
  assert.equal(await fixture.descendants.capture(), true);
  assert.equal(fixture.queries.length, 0);
});
