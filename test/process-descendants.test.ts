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

test("descendant custody excludes self and PID 1 from the shared process table", async (t) => {
  const fixture = windowsProcesses(t);
  fixture.snapshot.output =
    processRow(rootPid, process.pid, rootBirth) +
    processRow(process.pid, rootPid, childBirth) +
    processRow(1, rootPid, childBirth) +
    processRow(childPid, rootPid, childBirth);
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

test("descendant custody survives failed signals after its root exits", async (t) => {
  const fixture = windowsProcesses(t);
  fixture.snapshot.output =
    processRow(rootPid, process.pid, rootBirth) + processRow(childPid, rootPid, childBirth);
  assert.equal(await fixture.descendants.capture(), true);
  Object.assign(fixture.root, { exitCode: 0 });
  // No live root permits re-adoption: only retained birth-identity custody can keep C.
  fixture.snapshot.output = processRow(childPid, rootPid, childBirth);
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    fixture.signals.push({ pid, signal });
    throw Object.assign(new Error("synthetic signal denial"), { code: "EPERM" });
  });

  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    await fixture.descendants.signal(signal, 1_000);
    assert.equal(fixture.descendants.hasTrackedProcesses(), true, `${signal} denial lost custody`);
    assert.equal(
      await fixture.descendants.waitForExit(1),
      false,
      "signal failure is not retirement",
    );
  }
  assert.deepEqual(fixture.signals, [
    { pid: childPid, signal: "SIGTERM" },
    { pid: childPid, signal: "SIGKILL" },
  ]);
  fixture.snapshot.output = "";
  assert.equal(await fixture.descendants.waitForExit(1_000), true, "fresh absence retires custody");
  assert.equal(fixture.descendants.hasTrackedProcesses(), false);
});

const posixRootBirth = "Thu Sep 24 10:00:00 2026";
const posixChildBirth = "Thu Sep 24 10:00:01 2026";
const posixSiblingBirth = "Thu Sep 24 10:00:02 2026";
const posixReusedBirth = "Thu Sep 24 10:00:03 2026";
const posixAfterExitBirth = "Thu Sep 24 10:00:11 2026";

function posixRow(pid: number, parentPid: number, groupPid: number, birth: string): string {
  return `${pid} ${parentPid} ${groupPid} S ${birth}\n`;
}

function posixOwnership(t: TestContext) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  t.mock.method(Date, "now", () => Date.UTC(2026, 8, 24, 10, 0, 10));
  const root = Object.assign(new ChildProcess(), { pid: rootPid });
  const descendants = new ProcessDescendants(root, { ownProcessGroup: true });
  const snapshot = { output: "", error: null as Error | null, hold: false };
  const signals: Array<{ pid: number; signal?: string | number }> = [];
  const queries: Array<{ command: string; args: readonly string[] }> = [];
  type Reply = (error: Error | null, stdout: string, stderr: string) => void;
  let held: Reply | undefined;
  let signalHeld = () => {};
  const heldStarted = new Promise<void>((resolve) => {
    signalHeld = resolve;
  });
  const helper = new ChildProcess();
  t.mock.method(helper, "kill", () => true);
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    signals.push({ pid, signal });
    return true;
  });
  t.mock.method(childProcess, "execFile", ((
    command: string,
    args: readonly string[],
    options: ExecFileOptions,
    reply: Reply,
  ) => {
    queries.push({ command, args });
    assert.equal(command, "ps");
    assert.equal(options.env?.LC_ALL, "C");
    assert.equal(options.env?.TZ, "UTC");
    assert.ok(args.includes("pid=,ppid=,pgid=,stat=,lstart="));
    if (snapshot.hold) {
      assert.equal(held, undefined, "only one process query may be held");
      held = reply;
      signalHeld();
    } else {
      const { error, output } = snapshot;
      queueMicrotask(() => reply(error, output, ""));
    }
    return helper;
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  t.after(() => {
    held?.(new Error("synthetic query released during fixture teardown"), "", "");
    held = undefined;
    descendants.retire();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (platform) {
      Object.defineProperty(process, "platform", platform);
    }
  });
  return {
    root,
    descendants,
    snapshot,
    signals,
    queries,
    heldStarted,
    exitRoot() {
      Object.assign(root, { exitCode: 0 });
      root.emit("exit", 0, null);
    },
    releaseQuery(error: Error | null, output = snapshot.output) {
      assert.ok(held, "expected a started, held native query");
      const reply = held;
      held = undefined;
      snapshot.hold = false;
      reply(error, output, "");
    },
  };
}

function failedSnapshot(): Error {
  return Object.assign(new Error("synthetic process-table timeout"), { code: "ETIMEDOUT" });
}

test("a fresh live-root observation repairs a pending failed observation", async (t) => {
  const fixture = posixOwnership(t);
  fixture.snapshot.error = failedSnapshot();
  assert.equal(await fixture.descendants.capture(), false);
  fixture.snapshot.error = null;
  fixture.snapshot.output =
    posixRow(rootPid, process.pid, rootPid, posixRootBirth) +
    posixRow(childPid, rootPid, rootPid, posixChildBirth);
  assert.equal(await fixture.descendants.capture(), true);
  fixture.exitRoot();
  fixture.snapshot.output = posixRow(childPid, 1, rootPid, posixChildBirth);
  assert.equal(await fixture.descendants.capture(), true);
  assert.equal(fixture.descendants.hasUnresolvedOwnership(), false);
  fixture.snapshot.output = "";
  assert.equal(await fixture.descendants.waitForExit(1_000), true);
  assert.equal(fixture.descendants.hasUnresolvedOwnership(), false);
});

test("failed live-root observation preserves the unused POSIX exit-admission window", async (t) => {
  const fixture = posixOwnership(t);
  fixture.snapshot.error = failedSnapshot();
  assert.equal(await fixture.descendants.capture(), false);
  fixture.exitRoot();
  fixture.snapshot.error = null;
  fixture.snapshot.output = "";
  assert.equal(await fixture.descendants.capture(), true);
  assert.equal(fixture.descendants.hasTrackedProcesses(), false);
  assert.equal(
    fixture.descendants.hasUnresolvedOwnership(),
    false,
    "the original post-exit admission window can verify an empty owned group",
  );
});

test("failed first post-exit group observation is not repaired by an empty tracked set", async (t) => {
  const fixture = posixOwnership(t);
  fixture.snapshot.output = posixRow(rootPid, process.pid, rootPid, posixRootBirth);
  assert.equal(await fixture.descendants.capture(), true);
  fixture.exitRoot();
  fixture.snapshot.error = failedSnapshot();
  assert.equal(await fixture.descendants.capture(), false);
  assert.equal(fixture.descendants.hasUnresolvedOwnership(), true);
  fixture.snapshot.error = null;
  // There is a real row in the old group, but no retained witness authorizes adoption.
  fixture.snapshot.output = posixRow(childPid, 1, rootPid, posixChildBirth);
  await fixture.descendants.signal("SIGKILL", 1_000);
  assert.deepEqual(fixture.signals, [], "raw saved group number is not authority");
  assert.equal(fixture.descendants.hasTrackedProcesses(), false);
  assert.equal(fixture.descendants.hasUnresolvedOwnership(), true);
  fixture.snapshot.output = "";
  assert.equal(await fixture.descendants.capture(), true);
  assert.equal(fixture.descendants.hasUnresolvedOwnership(), true);
});

test("ordinary post-exit polling failure preserves witnesses and permits later verification", async (t) => {
  const fixture = posixOwnership(t);
  fixture.snapshot.output =
    posixRow(rootPid, process.pid, rootPid, posixRootBirth) +
    posixRow(childPid, rootPid, rootPid, posixChildBirth);
  assert.equal(await fixture.descendants.capture(), true);
  fixture.exitRoot();
  fixture.snapshot.output = posixRow(childPid, 1, rootPid, posixChildBirth);
  assert.equal(await fixture.descendants.capture(), true); // Exit admission succeeded.
  fixture.snapshot.error = failedSnapshot();
  assert.equal(await fixture.descendants.waitForExit(47), false);
  assert.equal(fixture.descendants.hasTrackedProcesses(), true);
  await fixture.descendants.signal("SIGTERM", 47);
  assert.deepEqual(fixture.signals, [], "failed snapshots cannot signal cached witnesses");
  fixture.snapshot.error = null;
  await fixture.descendants.signal("SIGKILL", 1_000);
  assert.deepEqual(fixture.signals, [{ pid: childPid, signal: "SIGKILL" }]);
  fixture.snapshot.output = "";
  assert.equal(await fixture.descendants.waitForExit(1_000), true);
  assert.equal(
    fixture.descendants.hasUnresolvedOwnership(),
    false,
    "ordinary polling timeout must not permanently poison later verified retirement",
  );
});

test("fresh matching group witness restores lost group admission within the exit cutoff", async (t) => {
  const fixture = posixOwnership(t);
  fixture.snapshot.output =
    posixRow(rootPid, process.pid, rootPid, posixRootBirth) +
    posixRow(childPid, rootPid, rootPid, posixChildBirth);
  assert.equal(await fixture.descendants.capture(), true);
  fixture.exitRoot();
  fixture.snapshot.error = failedSnapshot();
  assert.equal(await fixture.descendants.capture(), false);
  assert.equal(fixture.descendants.hasTrackedProcesses(), true);
  assert.equal(
    fixture.descendants.hasUnresolvedOwnership(),
    true,
    "cached witness alone cannot repair lost group admission",
  );
  fixture.snapshot.error = null;
  fixture.snapshot.output =
    posixRow(childPid, 1, rootPid, posixChildBirth) +
    posixRow(grandchildPid, 1, rootPid, posixSiblingBirth) +
    posixRow(grandchildPid + 1, 1, rootPid, posixAfterExitBirth) +
    posixRow(grandchildPid + 2, 1, rootPid + 10, posixSiblingBirth);
  await fixture.descendants.signal("SIGTERM", 1_000);
  assert.deepEqual(
    fixture.signals,
    [
      { pid: childPid, signal: "SIGTERM" },
      { pid: grandchildPid, signal: "SIGTERM" },
    ],
    "re-admit eligible group member; exclude future-birth and foreign-group rows",
  );
  assert.equal(fixture.descendants.hasUnresolvedOwnership(), false);
  fixture.snapshot.output = "";
  assert.equal(await fixture.descendants.waitForExit(1_000), true);
});

for (const witness of ["reused", "out-of-group"] as const) {
  test(`${witness} witness cannot restore lost group admission`, async (t) => {
    const fixture = posixOwnership(t);
    fixture.snapshot.output =
      posixRow(rootPid, process.pid, rootPid, posixRootBirth) +
      posixRow(childPid, rootPid, rootPid, posixChildBirth);
    assert.equal(await fixture.descendants.capture(), true);
    fixture.exitRoot();
    fixture.snapshot.error = failedSnapshot();
    assert.equal(await fixture.descendants.capture(), false);
    fixture.snapshot.error = null;
    fixture.snapshot.output =
      posixRow(
        childPid,
        1,
        witness === "out-of-group" ? rootPid + 10 : rootPid,
        witness === "reused" ? posixReusedBirth : posixChildBirth,
      ) + posixRow(grandchildPid, 1, rootPid, posixSiblingBirth);
    await fixture.descendants.signal("SIGTERM", 1_000);
    assert.deepEqual(
      fixture.signals,
      witness === "out-of-group" ? [{ pid: childPid, signal: "SIGTERM" }] : [],
      "only still-matching witnessed identity remains signal authority",
    );
    assert.equal(fixture.descendants.hasUnresolvedOwnership(), true);
    fixture.signals.length = 0;
    fixture.snapshot.output = "";
    assert.equal(await fixture.descendants.capture(), true);
    assert.equal(fixture.descendants.hasTrackedProcesses(), false);
    assert.equal(fixture.descendants.hasUnresolvedOwnership(), true);
    fixture.snapshot.output = posixRow(childPid, 1, rootPid, posixChildBirth);
    await fixture.descendants.signal("SIGKILL", 1_000);
    assert.deepEqual(fixture.signals, [], "forgotten identity cannot reappear as new authority");
    assert.equal(fixture.descendants.hasUnresolvedOwnership(), true);
  });
}

test("query begun while root is live can lose exit admission when it fails after exit", async (t) => {
  const fixture = posixOwnership(t);
  fixture.snapshot.output =
    posixRow(rootPid, process.pid, rootPid, posixRootBirth) +
    posixRow(childPid, rootPid, rootPid, posixChildBirth);
  assert.equal(await fixture.descendants.capture(), true);
  fixture.snapshot.hold = true;
  const queryCount = fixture.queries.length;
  const pending = fixture.descendants.capture(1_000);
  await fixture.heldStarted;
  assert.equal(fixture.queries.length, queryCount + 1, "query actually started before root exit");
  fixture.exitRoot();
  fixture.releaseQuery(failedSnapshot());
  assert.equal(await pending, false);
  assert.equal(
    fixture.descendants.hasUnresolvedOwnership(),
    true,
    "checking only rootWasRunning at query start misses this transition",
  );
  fixture.snapshot.output = "";
  assert.equal(await fixture.descendants.capture(), true);
  assert.equal(fixture.descendants.hasTrackedProcesses(), false);
  assert.equal(fixture.descendants.hasUnresolvedOwnership(), true);
});

test("a foreign birth-kind table cannot repair lost group ownership", async (t) => {
  const fixture = posixOwnership(t);
  fixture.snapshot.output =
    posixRow(rootPid, process.pid, rootPid, posixRootBirth) +
    posixRow(childPid, rootPid, rootPid, posixChildBirth);
  assert.equal(await fixture.descendants.capture(), true);
  fixture.exitRoot();
  fixture.snapshot.error = failedSnapshot();
  assert.equal(await fixture.descendants.capture(), false);
  fixture.snapshot.hold = true;
  const pending = fixture.descendants.capture(1_000);
  await fixture.heldStarted;
  // The ps query has started. Change only the mocked parser's identity kind
  // before returning its fake table, forcing verifyScope's unknown-kind guard.
  // This is not a claim of native Windows migration or Linux namespace proof.
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    fixture.releaseQuery(null, `${childPid} 1 ${rootPid} S 2026-09-24T10:00:01.0000000Z\n`);
    assert.equal(await pending, false);
  } finally {
    Object.defineProperty(process, "platform", { value: "darwin" });
  }
  assert.deepEqual(fixture.signals, []);
  assert.equal(fixture.descendants.hasUnresolvedOwnership(), true);
});

test("Windows cannot repair missed root observation through a retained descendant", async (t) => {
  const fixture = windowsProcesses(t);
  fixture.snapshot.output =
    processRow(rootPid, process.pid, rootBirth) + processRow(childPid, rootPid, childBirth);
  assert.equal(await fixture.descendants.capture(), true);
  fixture.snapshot.error = failedSnapshot();
  assert.equal(await fixture.descendants.capture(), false);
  Object.assign(fixture.root, { exitCode: 0 });
  fixture.root.emit("exit", 0, null);
  fixture.snapshot.error = null;
  fixture.snapshot.output =
    processRow(childPid, rootPid, childBirth) + processRow(grandchildPid, rootPid, laterBirth);
  await fixture.descendants.signal("SIGTERM", 1_000);
  assert.deepEqual(fixture.signals, [{ pid: childPid, signal: "SIGTERM" }]);
  assert.equal(
    fixture.descendants.hasUnresolvedOwnership(),
    true,
    "one freshly matching Windows child does not establish unobserved sibling custody",
  );
  fixture.snapshot.output = "";
  assert.equal(await fixture.descendants.capture(), true);
  assert.equal(fixture.descendants.hasTrackedProcesses(), false);
  assert.equal(fixture.descendants.hasUnresolvedOwnership(), true);
});
