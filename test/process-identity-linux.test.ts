import assert from "node:assert/strict";
import childProcess, { ChildProcess, type ExecFileOptions } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import test, { type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import {
  compareProcessBirthIdentity,
  observeProcessIncarnation,
  parseProcessBirthIdentity,
  probeProcessIdentity,
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

function stat(pid: number, ticks: string = identity.startTicks, comm = "fixture"): string {
  return `${pid} (${comm}) S ${Array<string>(18).fill("0").join(" ")} ${ticks} 0 0\n`;
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
