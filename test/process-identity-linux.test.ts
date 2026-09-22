import assert from "node:assert/strict";
import childProcess, { ChildProcess, type ExecFileOptions } from "node:child_process";
import { once } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import test, { type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import { ProcessDescendants } from "../src/acp/process-descendants.js";
import {
  compareProcessBirthIdentity,
  observeProcessIncarnation,
  parseProcessBirthIdentity,
  probeProcessIdentity,
  readLinuxExitClock,
  readProcessTable,
  type ProcessBirthIdentity,
} from "../src/process-identity.js";
import {
  readQueueOwnerRecord,
  resolveUsableQueueOwner,
  terminateQueueOwnerForSession,
} from "../src/session/queue/lease-store.js";
import { queuePaths, withTempHome, writeQueueOwnerLock } from "./queue-test-helpers.js";

const fixturePid = 2_000_001;
const helperPid = 2_000_002;
const identity = {
  kind: "linux-proc",
  bootId: "12345678-1234-1234-1234-123456789abc",
  pidNamespace: "pid:[4026531836]",
  timeNamespace: "time:[4026531834]",
  startTicks: "9007199254740993",
} as const;

function stat(
  pid: number,
  ticks: string = identity.startTicks,
  comm = "fixture",
  parentPid = 0,
  groupPid = 0,
): string {
  const fields = Array<string>(18).fill("0");
  fields[0] = String(parentPid);
  fields[1] = String(groupPid);
  return `${pid} (${comm}) S ${fields.join(" ")} ${ticks} 0 0\n`;
}

function processClock(size = 8, littleEndian = true, frequency = 100n) {
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, size === 4 ? 1 : 2, littleEndian ? 1 : 2]);
  const auxv = Buffer.alloc(size * 4);
  const word = (offset: number, value: bigint) => {
    if (size === 8) {
      if (littleEndian) {
        auxv.writeBigUInt64LE(value, offset);
      } else {
        auxv.writeBigUInt64BE(value, offset);
      }
    } else if (littleEndian) {
      auxv.writeUInt32LE(Number(value), offset);
    } else {
      auxv.writeUInt32BE(Number(value), offset);
    }
  };
  word(0, 17n);
  word(size, frequency);
  return { elf: elf.toString("base64"), auxv: auxv.toString("base64") };
}

function processTable(processStats = [stat(fixturePid)]) {
  return { ...procObservation(), ...processClock(), processStats };
}

function mockExitClock(t: TestContext) {
  const state = { uptime: "20.00 0.00\n", error: false, closed: 0 };
  t.mock.method(fsSync, "openSync", (file: string) => {
    assert.equal(file, "/proc/uptime");
    return 91;
  });
  t.mock.method(fsSync, "readSync", (_fd: number, buffer: Buffer) => {
    assert.equal(buffer.length, 64);
    if (state.error) {
      throw new Error("unavailable proc clock");
    }
    return buffer.write(state.uptime);
  });
  t.mock.method(fsSync, "closeSync", (fd: number) => {
    assert.equal(fd, 91);
    state.closed += 1;
  });
  t.mock.method(fsSync, "readlinkSync", () => identity.timeNamespace);
  return state;
}

function procObservation(): Record<string, unknown> {
  return {
    ...identity,
    observerPidNamespace: identity.pidNamespace,
    observerTimeNamespace: identity.timeNamespace,
    helperPid,
    selfStat: stat(helperPid),
    targetStat: stat(fixturePid),
  };
}

function linuxQuery(t: TestContext) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
  const state = { observation: procObservation(), error: null as Error | null, dead: false };
  const queries: Array<{ command: string; args: readonly string[]; options: ExecFileOptions }> = [];
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    assert.equal(signal, 0, "identity observations must not send termination signals");
    if (pid === fixturePid && state.dead) {
      throw Object.assign(new Error("no local PID"), { code: "ESRCH" });
    }
    return true;
  });
  t.mock.method(childProcess, "execFile", ((
    command: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    queries.push({ command, args, options });
    queueMicrotask(() => callback(state.error, JSON.stringify(state.observation), ""));
    return new ChildProcess();
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (platform) {
      Object.defineProperty(process, "platform", platform);
    }
  });
  return { state, queries };
}

test("Linux persisted identity keeps exact ticks and validates its entire observation scope", () => {
  assert.deepEqual(parseProcessBirthIdentity(identity), identity);
  const unsupported = { ...identity, timeNamespace: "unsupported" };
  assert.deepEqual(parseProcessBirthIdentity(unsupported), unsupported);
  for (const patch of [
    { startTicks: 123 },
    { startTicks: "1.1" },
    { startTicks: "01" },
    { startTicks: "-1" },
    { bootId: "" },
    { pidNamespace: "pid:[0]" },
    { timeNamespace: "" },
    { timeNamespace: undefined },
  ]) {
    assert.equal(parseProcessBirthIdentity({ ...identity, ...patch }), undefined);
  }
});

test("Linux comparison distinguishes another incarnation from an unknown namespace", () => {
  assert.equal(compareProcessBirthIdentity(identity, identity), "matching");
  for (const patch of [
    { startTicks: "9007199254740994" },
    { bootId: "87654321-1234-1234-1234-123456789abc" },
  ]) {
    assert.equal(compareProcessBirthIdentity(identity, { ...identity, ...patch }), "different");
  }
  for (const patch of [
    { pidNamespace: "pid:[4026531837]" },
    { timeNamespace: "time:[4026531835]" },
    { timeNamespace: "unsupported" },
  ]) {
    assert.equal(compareProcessBirthIdentity(identity, { ...identity, ...patch }), "unknown");
  }
  assert.equal(compareProcessBirthIdentity(undefined, identity), "unknown");
  assert.equal(
    compareProcessBirthIdentity(
      { kind: "posix-lstart", value: "2026-01-01T00:00:00.000Z" },
      identity,
    ),
    "unknown",
  );
});

test("Linux queries parse raw stat ticks after the final comm delimiter and ignore wall clocks", async (t) => {
  const fixture = linuxQuery(t);
  fixture.state.observation.targetStat = stat(
    fixturePid,
    identity.startTicks,
    "a ) nested\n(name)",
  );
  let clock = 1;
  t.mock.method(Date, "now", () => clock);
  const before = await probeProcessIdentity(fixturePid);
  clock = 9_000_000_000_000;
  const after = await probeProcessIdentity(fixturePid);
  assert.deepEqual(before, { state: "alive", identity });
  assert.deepEqual(after, before, "a wall-clock step must not change a live process identity");
  assert.equal(await observeProcessIncarnation(fixturePid, identity), "matching");
  assert.equal(fixture.queries.length, 3, "foreign process observations are never cached");
  const query = fixture.queries[0];
  assert.equal(query.command, process.execPath);
  assert.deepEqual(query.args.slice(-2), [String(fixturePid), String(process.pid)]);
  assert.equal(query.options.env?.NODE_OPTIONS, "");
  assert.equal(query.options.maxBuffer, 8_192);
});

test("Linux query failures and malformed proc views remain unknown without a ps fallback", async (t) => {
  const fixture = linuxQuery(t);
  for (const patch of [
    { targetStat: null },
    { targetStat: stat(fixturePid + 1) },
    { targetStat: stat(fixturePid, "1e6") },
    { targetStat: `${fixturePid} (short) S 1` },
    { targetStat: stat(fixturePid).replace(") S ", ") Z ") },
    { selfStat: stat(helperPid + 1) },
    { selfStat: undefined, helperPid: undefined },
    { observerPidNamespace: "pid:[123]" },
    { observerTimeNamespace: "time:[123]" },
    { observerTimeNamespace: "unsupported" },
    { timeNamespace: undefined },
    { bootId: "invalid" },
  ]) {
    fixture.state.observation = { ...procObservation(), ...patch };
    assert.deepEqual(await probeProcessIdentity(fixturePid), { state: "unknown" });
    assert.equal(await observeProcessIncarnation(fixturePid, identity), "unknown");
  }
  fixture.state.observation = procObservation();
  fixture.state.error = Object.assign(new Error("proc access denied"), { code: "EACCES" });
  assert.equal(await observeProcessIncarnation(fixturePid, identity), "unknown");
  assert(fixture.queries.every((query) => query.command === process.execPath));
});

test("Linux observation validates saved scope before accepting local ESRCH", async (t) => {
  const fixture = linuxQuery(t);
  fixture.state.dead = true;
  fixture.state.observation.targetStat = null;
  assert.equal(await observeProcessIncarnation(fixturePid, identity), "gone");
  for (const patch of [
    { pidNamespace: "pid:[123]" },
    { timeNamespace: "time:[123]" },
    { timeNamespace: "unsupported" },
  ]) {
    assert.equal(await observeProcessIncarnation(fixturePid, { ...identity, ...patch }), "unknown");
  }
  assert.equal(
    await observeProcessIncarnation(fixturePid, {
      ...identity,
      bootId: "87654321-1234-1234-1234-123456789abc",
    }),
    "gone",
  );
  fixture.state.error = new Error("scope unavailable");
  assert.equal(await observeProcessIncarnation(fixturePid, identity), "unknown");
  assert.equal(
    await observeProcessIncarnation(fixturePid),
    "gone",
    "legacy local ESRCH remains recoverable",
  );
  assert.equal(
    await observeProcessIncarnation(fixturePid, {
      kind: "posix-lstart",
      value: "2026-01-01T00:00:00.000Z",
    }),
    "unknown",
  );
});

test("Linux alive observations allow only same-scope tick mismatch or an earlier boot", async (t) => {
  const fixture = linuxQuery(t);
  assert.equal(await observeProcessIncarnation(fixturePid, identity), "matching");
  assert.equal(
    await observeProcessIncarnation(fixturePid, { ...identity, startTicks: "1" }),
    "gone",
  );
  assert.equal(await observeProcessIncarnation(fixturePid), "unknown");
  assert.equal(await observeProcessIncarnation(0, identity), "unknown");
  fixture.state.observation.targetStat = null;
  assert.equal(
    await observeProcessIncarnation(fixturePid, {
      ...identity,
      bootId: "87654321-1234-1234-1234-123456789abc",
    }),
    "gone",
  );
});

test("Linux helper treats only missing time-namespace support as a shared explicit scope", async (t) => {
  const fixture = linuxQuery(t);
  await probeProcessIdentity(fixturePid);
  const source = fixture.queries[0].args[2];
  for (const timeError of ["ENOENT", "EACCES"]) {
    let output = "";
    const helperProcess = {
      argv: ["node", String(fixturePid), String(process.pid)],
      pid: helperPid,
      ppid: process.pid,
      exitCode: 0,
      stdout: {
        write: (value: string) => {
          output += value;
        },
      },
    };
    const proc = {
      readFile: async (file: string) => {
        if (file.endsWith("boot_id")) {
          return identity.bootId;
        }
        return stat(file === "/proc/self/stat" ? helperPid : fixturePid);
      },
      readlink: async (file: string) => {
        if (file.endsWith("/time")) {
          throw Object.assign(new Error(timeError), { code: timeError });
        }
        return identity.pidNamespace;
      },
    };
    await (runInNewContext(source, {
      process: helperProcess,
      require: (module: string) => {
        assert.equal(module, "node:fs/promises");
        return proc;
      },
    }) as Promise<void>);
    if (timeError === "ENOENT") {
      fixture.state.observation = JSON.parse(output) as Record<string, unknown>;
      assert.deepEqual(await probeProcessIdentity(fixturePid), {
        state: "alive",
        identity: { ...identity, timeNamespace: "unsupported" },
      });
    } else {
      assert.equal(helperProcess.exitCode, 1);
      assert.equal(output, "");
    }
  }
});

test("Linux table helper bounds sequential reads and requires access only to witnessed PIDs", async (t) => {
  const fixture = linuxQuery(t);
  fixture.state.observation = processTable();
  await readProcessTable(100);
  const source = fixture.queries[0].args[2];
  for (const failure of [undefined, "ENOENT", "EACCES", "EPERM", "EIO", "oversize"]) {
    let output = "";
    let active = 0;
    let peak = 0;
    let closed = 0;
    const helperProcess = {
      argv: ["node", "all", String(process.pid), JSON.stringify([fixturePid])],
      pid: helperPid,
      ppid: process.pid,
      exitCode: 0,
      stdout: {
        write: (value: string) => {
          output += value;
        },
      },
    };
    const proc = {
      readdir: async () => [String(fixturePid + 1), "self", String(fixturePid)],
      readlink: async (file: string) =>
        file.endsWith("/time") ? identity.timeNamespace : identity.pidNamespace,
      readFile: async (file: string) => {
        if (file.endsWith("boot_id")) {
          return identity.bootId;
        }
        if (file === "/proc/self/stat") {
          return stat(helperPid);
        }
        active += 1;
        peak = Math.max(peak, active);
        try {
          await Promise.resolve();
          if (file === `/proc/${fixturePid + 1}/stat`) {
            throw Object.assign(new Error("foreign access denied"), { code: "EACCES" });
          }
          if (failure === "oversize") {
            return "x".repeat(32 * 1024 * 1024);
          }
          if (failure) {
            throw Object.assign(new Error(failure), { code: failure });
          }
          return stat(fixturePid);
        } finally {
          active -= 1;
        }
      },
      open: async (file: string) => ({
        read: async (buffer: Buffer, offset: number, length: number) => {
          assert.equal(length, file.endsWith("auxv") ? 4096 : 6);
          const clock = processClock();
          const value = Buffer.from(file.endsWith("auxv") ? clock.auxv : clock.elf, "base64");
          return { bytesRead: value.copy(buffer, offset) };
        },
        close: async () => {
          closed += 1;
        },
      }),
    };
    await (runInNewContext(source, {
      process: helperProcess,
      Buffer,
      require: (module: string) => {
        assert.equal(module, "node:fs/promises");
        return proc;
      },
    }) as Promise<void>);
    assert.equal(peak, 1, "target proc reads must never fan out concurrently");
    if (!failure || failure === "ENOENT") {
      assert.equal(helperProcess.exitCode, 0);
      const result = JSON.parse(output) as { processStats: string[] };
      assert.deepEqual(result.processStats, failure ? [] : [stat(fixturePid)]);
      assert.equal(closed, 2, "both capped native metadata reads close their descriptors");
    } else {
      assert.equal(helperProcess.exitCode, 1);
      assert.equal(
        output,
        "",
        "uncertain or oversized observations must not publish a partial table",
      );
    }
  }
});

test("Linux tables keep scoped raw ticks with native-width and native-endian clock frequencies", async (t) => {
  const fixture = linuxQuery(t);
  for (const size of [4, 8]) {
    for (const littleEndian of [true, false]) {
      fixture.state.observation = {
        ...processTable([stat(fixturePid, identity.startTicks, "a )\n(b)", 12, 34)]),
        ...processClock(size, littleEndian, 1024n),
      };
      const table = await readProcessTable(100, undefined, [fixturePid]);
      assert.deepEqual(
        [...table.values()],
        [
          {
            pid: fixturePid,
            parentPid: 12,
            groupPid: 34,
            birth: identity,
            clockTicksPerSecond: 1024n,
          },
        ],
      );
    }
  }
  assert.equal(fixture.queries.length, 4, "each table capture uses exactly one helper");
  assert.ok(fixture.queries.every((query) => query.command === process.execPath));
  assert.equal(fixture.queries[0].options.maxBuffer, 32 * 1024 * 1024);
  assert.deepEqual(fixture.queries[0].args.slice(-3), [
    "all",
    String(process.pid),
    JSON.stringify([fixturePid]),
  ]);
});

test("Linux tables reject invalid clock metadata and foreign observation scope", async (t) => {
  const fixture = linuxQuery(t);
  for (const patch of [
    { elf: "" },
    { elf: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 3, 1]).toString("base64") },
    { auxv: "" },
    processClock(8, true, 0n),
    { observerPidNamespace: "pid:[123]" },
    { observerTimeNamespace: "time:[123]" },
    { selfStat: stat(helperPid + 1) },
  ]) {
    fixture.state.observation = { ...processTable(), ...patch };
    await assert.rejects(readProcessTable(100));
  }
});

test("Linux exit clock reads a capped centisecond interval and closes failed observations", (t) => {
  const clock = mockExitClock(t);
  assert.deepEqual(readLinuxExitClock(), {
    centiseconds: 2000n,
    timeNamespace: identity.timeNamespace,
  });
  clock.uptime = "20 0\n";
  assert.equal(readLinuxExitClock(), undefined);
  clock.error = true;
  assert.equal(readLinuxExitClock(), undefined);
  assert.equal(clock.closed, 3);
});

test("Linux descendants preserve custody across clock steps and stop requiring an exited root PID", async (t) => {
  const fixture = linuxQuery(t);
  const root = new ChildProcess();
  Object.assign(root, { pid: fixturePid });
  const leafPid = fixturePid + 10;
  const descendants = new ProcessDescendants(root);
  t.after(() => descendants.retire());
  fixture.state.observation = processTable([
    stat(fixturePid, "100"),
    stat(leafPid, "120", "leaf", fixturePid, leafPid),
  ]);
  const signals: number[] = [];
  t.mock.method(process, "kill", (pid: number) => {
    signals.push(pid);
    return true;
  });
  assert.equal(await descendants.capture(), true);
  assert.deepEqual(JSON.parse(fixture.queries[0].args.at(-1)!), [fixturePid]);

  Object.assign(root, { exitCode: 0 });
  root.emit("exit", 0, null);
  fixture.state.observation = processTable([stat(leafPid, "120", "leaf", 1, leafPid)]);
  t.mock.method(Date, "now", () => 9_000_000_000_000);
  await descendants.signal("SIGTERM", 100);
  assert.deepEqual(signals, [leafPid]);
  assert.deepEqual(
    JSON.parse(fixture.queries[1].args.at(-1)!),
    [leafPid],
    "an inaccessible reused root PID must not invalidate the remaining custody",
  );

  signals.length = 0;
  fixture.state.observation = processTable([stat(leafPid, "121", "reused", 1, leafPid)]);
  await descendants.signal("SIGKILL", 100);
  assert.deepEqual(signals, []);
  assert.equal(descendants.hasTrackedProcesses(), false);
});

test("Linux terminal group admission uses the recorded boot-clock interval after a wall-clock step", async (t) => {
  const fixture = linuxQuery(t);
  const clock = mockExitClock(t);
  const root = new ChildProcess();
  Object.assign(root, { pid: fixturePid });
  const leafPid = fixturePid + 10;
  const descendants = new ProcessDescendants(root, { ownProcessGroup: true });
  t.after(() => descendants.retire());
  fixture.state.observation = processTable([stat(fixturePid, "100")]);
  assert.equal(await descendants.capture(), true);
  Object.assign(root, { exitCode: 0 });
  root.emit("exit", 0, null);
  clock.uptime = "5000.00 0.00\n";
  t.mock.method(Date, "now", () => 1);
  fixture.state.observation = processTable([
    stat(leafPid, "2000", "last-fork", 1, fixturePid),
    stat(leafPid + 1, "2001", "later-group", 1, fixturePid),
  ]);
  const signals: number[] = [];
  t.mock.method(process, "kill", (pid: number) => {
    signals.push(pid);
    return true;
  });
  await descendants.signal("SIGTERM", 100);
  assert.deepEqual(
    signals,
    [leafPid],
    "only the recorded exit interval may admit the final group snapshot",
  );
  assert.equal(clock.closed, 1, "polls must not resample the exit clock");
});

test("an unavailable Linux exit clock stops new group adoption but keeps witnessed descendants", async (t) => {
  const fixture = linuxQuery(t);
  const clock = mockExitClock(t);
  const root = new ChildProcess();
  Object.assign(root, { pid: fixturePid });
  const leafPid = fixturePid + 10;
  const descendants = new ProcessDescendants(root, { ownProcessGroup: true });
  t.after(() => descendants.retire());
  fixture.state.observation = processTable([
    stat(fixturePid, "100"),
    stat(leafPid, "120", "leaf", fixturePid, fixturePid),
  ]);
  assert.equal(await descendants.capture(), true);
  clock.error = true;
  Object.assign(root, { exitCode: 0 });
  root.emit("exit", 0, null);
  fixture.state.observation = processTable([
    stat(leafPid, "120", "leaf", 1, fixturePid),
    stat(leafPid + 1, "130", "unwitnessed", 1, fixturePid),
  ]);
  const signals: number[] = [];
  t.mock.method(process, "kill", (pid: number) => {
    signals.push(pid);
    return true;
  });
  await descendants.signal("SIGTERM", 100);
  assert.deepEqual(signals, [leafPid]);
});

test("changed Linux table scope keeps custody uncertain instead of signaling or forgetting it", async (t) => {
  const fixture = linuxQuery(t);
  const root = new ChildProcess();
  Object.assign(root, { pid: fixturePid });
  const descendants = new ProcessDescendants(root);
  t.after(() => descendants.retire());
  fixture.state.observation = processTable([
    stat(fixturePid),
    stat(fixturePid + 10, "120", "leaf", fixturePid),
  ]);
  assert.equal(await descendants.capture(), true);
  fixture.state.observation = {
    ...fixture.state.observation,
    timeNamespace: "time:[123]",
    observerTimeNamespace: "time:[123]",
  };
  assert.equal(await descendants.capture(), false);
  assert.equal(descendants.hasTrackedProcesses(), true);
  await descendants.signal("SIGTERM", 100);
});

test("Linux descendant waits use a monotonic deadline without continuing after return", async (t) => {
  const fixture = linuxQuery(t);
  const root = new ChildProcess();
  Object.assign(root, { pid: fixturePid });
  const descendants = new ProcessDescendants(root);
  t.after(() => descendants.retire());
  fixture.state.observation = processTable([
    stat(fixturePid),
    stat(fixturePid + 10, "120", "leaf", fixturePid),
  ]);
  let wallTime = 1_000_000;
  t.mock.method(Date, "now", () => {
    wallTime -= 60_000;
    return wallTime;
  });
  const started = performance.now();
  assert.equal(await descendants.waitForExit(25), false);
  assert.ok(performance.now() - started < 1_000);
  const queries = fixture.queries.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fixture.queries.length, queries);
});

test("Linux concurrent descendant captures share one table helper", async (t) => {
  const fixture = linuxQuery(t);
  fixture.state.observation = processTable([stat(fixturePid)]);
  const root = new ChildProcess();
  Object.assign(root, { pid: fixturePid });
  const descendants = new ProcessDescendants(root);
  t.after(() => descendants.retire());
  const results = await Promise.all([
    descendants.capture(),
    descendants.capture(),
    descendants.capture(),
  ]);
  assert.deepEqual(results, [true, true, true]);
  assert.equal(fixture.queries.length, 1);
});

test("foreign Linux scope plus local ESRCH retains queue custody and reports uncertainty", async (t) => {
  const fixture = linuxQuery(t);
  fixture.state.dead = true;
  fixture.state.observation.targetStat = null;
  await withTempHome(async (homeDir) => {
    t.mock.method(os, "homedir", () => homeDir);
    const sessionId = "foreign-scope-local-esrch";
    const paths = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({
      ...paths,
      sessionId,
      pid: fixturePid,
      heartbeatAt: "2000-01-01T00:00:00.000Z",
      processIdentity: { ...identity, pidNamespace: "pid:[123]" },
    });
    const payload = await fs.readFile(paths.lockPath, "utf8");
    const owner = await readQueueOwnerRecord(sessionId);
    assert(owner);
    await assert.rejects(resolveUsableQueueOwner(sessionId, owner), {
      detailCode: "QUEUE_OWNER_IDENTITY_UNVERIFIED",
    });
    let now = Date.now();
    t.mock.method(Date, "now", () => (now += 20_000));
    await assert.rejects(terminateQueueOwnerForSession(sessionId, owner), {
      detailCode: "QUEUE_OWNER_IDENTITY_UNVERIFIED",
    });
    assert.equal(await fs.readFile(paths.lockPath, "utf8"), payload);
  });
});

test(
  "native Linux identity matches proc start ticks and ignores inherited Node preloads",
  { skip: process.platform !== "linux" },
  async (t) => {
    const original = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = "--require=/proc/self/acpx-missing-preload";
    try {
      const raw = await fs.readFile("/proc/self/stat", "utf8");
      const startTicks = raw
        .slice(raw.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/u)[19];
      const samples: number[] = [];
      let previous: ProcessBirthIdentity | undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const started = performance.now();
        const probe = await probeProcessIdentity(process.pid);
        samples.push(Math.round(performance.now() - started));
        assert.equal(probe.state, "alive");
        if (probe.state !== "alive") {
          throw new Error("Linux self identity unavailable");
        }
        assert.equal(probe.identity.kind, "linux-proc");
        if (probe.identity.kind !== "linux-proc") {
          throw new Error("Expected proc identity");
        }
        assert.equal(probe.identity.startTicks, startTicks);
        assert.equal(
          probe.identity.bootId,
          (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
        );
        if (previous) {
          assert.deepEqual(probe.identity, previous);
        }
        previous = probe.identity;
      }
      t.diagnostic(`native Linux proc-helper durations (ms): ${samples.join(", ")}`);
    } finally {
      if (original === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = original;
      }
    }
  },
);

test(
  "native Linux timed-out identity helpers eventually exit without accumulating children",
  { skip: process.platform !== "linux", timeout: 10_000 },
  async (t) => {
    const execute = childProcess.execFile.bind(childProcess);
    const children: Array<{ child: ChildProcess; closed: Promise<unknown> }> = [];
    t.mock.method(childProcess, "execFile", ((
      command: string,
      _args: readonly string[],
      options: ExecFileOptions,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const child = execute(
        command,
        ["-e", "setInterval(() => {}, 1000)"],
        { ...options, encoding: "utf8" },
        callback,
      );
      children.push({ child, closed: once(child, "close") });
      return child;
    }) as typeof childProcess.execFile);
    syncBuiltinESMExports();
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const started = performance.now();
        assert.deepEqual(await probeProcessIdentity(process.pid, 25), { state: "unknown" });
        const { child, closed } = children[attempt];
        await Promise.race([
          closed,
          new Promise((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error("identity helper did not exit")),
              2_000,
            );
            void closed.finally(() => clearTimeout(timer));
          }),
        ]);
        assert.equal(child.signalCode, "SIGKILL");
        t.diagnostic(
          `timed-out helper fully closed after ${Math.round(performance.now() - started)}ms`,
        );
      }
      assert(children.every(({ child }) => child.signalCode === "SIGKILL"));
    } finally {
      for (const { child, closed } of children) {
        if (child.exitCode == null && child.signalCode == null) {
          child.kill("SIGKILL");
        }
        await closed;
      }
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  },
);
