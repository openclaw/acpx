import assert from "node:assert/strict";
import childProcess, { ChildProcess, type ExecFileOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { runTimedExecFile } from "../src/acp/client-process.js";
import {
  getOwnProcessIdentity,
  parseProcessBirthIdentity,
  probeProcessIdentity,
  readProcessTable,
} from "../src/process-identity.js";

const fixturePid = 2_000_001;
const posixBirth = "2026-09-21T10:00:01.000Z";
const windowsBirth = "2026-09-21T10:00:01.1234567Z";

function processQuery(t: TestContext, platform: NodeJS.Platform = "darwin") {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalRoot = process.env.SystemRoot;
  Object.defineProperty(process, "platform", { value: platform });
  process.env.SystemRoot = "C:\\Windows";
  const state = { output: "", error: null as Error | null, signalError: "", hang: false };
  const queries: Array<{ command: string; args: readonly string[]; options: ExecFileOptions }> = [];
  const helperSignals: Array<string | number | undefined> = [];
  const helper = new ChildProcess();
  t.mock.method(helper, "kill", (signal?: string | number) => {
    helperSignals.push(signal);
    return true;
  });
  t.mock.method(process, "kill", (_pid: number, signal?: string | number) => {
    assert.equal(signal, 0, "identity discovery must never signal a process");
    if (state.signalError) {
      throw Object.assign(new Error(state.signalError), { code: state.signalError });
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
    if (!state.hang) {
      queueMicrotask(() => callback(state.error, state.output, ""));
    }
    return helper;
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
    if (originalRoot === undefined) {
      delete process.env.SystemRoot;
    } else {
      process.env.SystemRoot = originalRoot;
    }
  });
  return { state, queries, helperSignals };
}

test("persisted birth identities accept canonical timestamps and reject ambiguous shapes", () => {
  for (const identity of [
    { kind: "posix-lstart", value: posixBirth },
    { kind: "windows-creation", value: windowsBirth },
  ]) {
    assert.deepEqual(parseProcessBirthIdentity(identity), identity);
  }
  for (const raw of [
    undefined,
    [],
    { kind: "foreign", value: posixBirth },
    { kind: "posix-lstart", value: "Mon Sep 21 10:00:01 2026" },
    { kind: "posix-lstart", value: windowsBirth },
    { kind: "posix-lstart", value: "2026-02-30T10:00:01.000Z" },
    { kind: "windows-creation", value: "2026-09-21T10:00:01.1234567+01:00" },
  ]) {
    assert.equal(parseProcessBirthIdentity(raw), undefined);
  }
});

test("POSIX identity probes include self and PID 1 and use a narrow UTC query", async (t) => {
  const fixture = processQuery(t);
  fixture.state.output = `1 0 1 S Mon Sep 21 10:00:01 2026\n${process.pid} 1 1 S Mon Sep 21 10:00:01 2026\n`;
  for (const pid of [1, process.pid]) {
    assert.deepEqual(await probeProcessIdentity(pid), {
      state: "alive",
      identity: { kind: "posix-lstart", value: posixBirth },
    });
  }
  assert.deepEqual(fixture.queries[0]?.args, ["-p", "1", "-o", "pid=,ppid=,pgid=,stat=,lstart="]);
  assert.equal(fixture.queries[0]?.options.env?.LC_ALL, "C");
  assert.equal(fixture.queries[0]?.options.env?.TZ, "UTC");
});

test("Windows identity probes retain precision and filter the requested PID", async (t) => {
  const fixture = processQuery(t, "win32");
  fixture.state.output = `${fixturePid} 1 0 S ${windowsBirth}\r\n`;
  assert.deepEqual(await probeProcessIdentity(fixturePid), {
    state: "alive",
    identity: { kind: "windows-creation", value: windowsBirth },
  });
  assert.equal(
    fixture.queries[0]?.command,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.match(fixture.queries[0]?.args[4] ?? "", /-Filter 'ProcessId = 2000001'/u);
  assert.equal(fixture.queries[0]?.options.windowsHide, true);
});

test("only confirmed ESRCH is dead and avoids launching an identity helper", async (t) => {
  const fixture = processQuery(t);
  fixture.state.signalError = "ESRCH";
  assert.deepEqual(await probeProcessIdentity(fixturePid), { state: "dead" });
  assert.equal(fixture.queries.length, 0);
  fixture.state.signalError = "EPERM";
  assert.deepEqual(await probeProcessIdentity(fixturePid), { state: "unknown" });
  assert.equal(fixture.queries.length, 1);
});

test("missing, zombie and malformed query rows preserve uncertain custody", async (t) => {
  const fixture = processQuery(t);
  for (const output of [
    "",
    `${fixturePid} 1 1 Z Mon Sep 21 10:00:01 2026\n`,
    `${fixturePid} 1 1 S Mon Feb 30 10:00:01 2026\n`,
  ]) {
    fixture.state.output = output;
    assert.deepEqual(await probeProcessIdentity(fixturePid), { state: "unknown" });
  }
  fixture.state.error = new Error("query unavailable");
  assert.deepEqual(await probeProcessIdentity(fixturePid), { state: "unknown" });
});

test("invalid PID input launches no helper", async (t) => {
  const fixture = processQuery(t);
  for (const pid of [0, -1, Number.NaN, Infinity, 1.5]) {
    assert.deepEqual(await probeProcessIdentity(pid), { state: "unknown" });
  }
  assert.equal(fixture.queries.length, 0);
});

test("identity query timeout retires its helper and reports uncertainty", async (t) => {
  const fixture = processQuery(t);
  fixture.state.hang = true;
  assert.deepEqual(await probeProcessIdentity(fixturePid, 10), { state: "unknown" });
  assert.deepEqual(fixture.helperSignals, ["SIGKILL"]);
});

test("new probes never reuse an earlier PID identity observation", async (t) => {
  const fixture = processQuery(t, "win32");
  fixture.state.output = `${fixturePid} 1 0 S ${windowsBirth}\n`;
  const first = await probeProcessIdentity(fixturePid);
  fixture.state.output = `${fixturePid} 1 0 S 2026-09-21T10:00:02.1234567Z\n`;
  assert.notDeepEqual(await probeProcessIdentity(fixturePid), first);
  assert.equal(fixture.queries.length, 2);
  await Promise.all([probeProcessIdentity(fixturePid), probeProcessIdentity(fixturePid)]);
  assert.equal(fixture.queries.length, 4, "concurrent foreign probes must remain fresh");
});

test("self identity coalesces concurrent queries and caches success only", async (t) => {
  const fixture = processQuery(t);
  assert.deepEqual(
    await Promise.all([getOwnProcessIdentity(), getOwnProcessIdentity(), getOwnProcessIdentity()]),
    [undefined, undefined, undefined],
  );
  assert.equal(fixture.queries.length, 1, "one failing helper serves concurrent callers");
  fixture.state.output = `${process.pid} 1 1 S Mon Sep 21 10:00:01 2026\n`;
  const identity = { kind: "posix-lstart", value: posixBirth };
  assert.deepEqual(
    await Promise.all([getOwnProcessIdentity(), getOwnProcessIdentity(), getOwnProcessIdentity()]),
    [identity, identity, identity],
  );
  fixture.state.output = "";
  assert.deepEqual(await getOwnProcessIdentity(), identity);
  assert.equal(fixture.queries.length, 2);
});

test("full process tables preserve group ownership and exclude zombie rows", async (t) => {
  const fixture = processQuery(t);
  fixture.state.output = `${fixturePid} 1 42 S Mon Sep 21 10:00:01 2026\n${fixturePid + 1} 1 42 Z Mon Sep 21 10:00:01 2026\n`;
  const table = await readProcessTable(100);
  assert.deepEqual(
    [...table.values()],
    [{ pid: fixturePid, parentPid: 1, groupPid: 42, birth: posixBirth }],
  );
  assert.equal(fixture.queries[0]?.args[0], "-e");
});

test("native narrow queries return stable birth identities within the default bound", async (t) => {
  const samples = [];
  let previous;
  for (let index = 0; index < 3; index += 1) {
    const started = performance.now();
    const probe = await probeProcessIdentity(process.pid);
    samples.push(Math.round(performance.now() - started));
    assert.equal(probe.state, "alive");
    if (previous) {
      assert.deepEqual(probe, previous);
    }
    previous = probe;
  }
  t.diagnostic(`native identity query durations (ms): ${samples.join(", ")}`);
});

test(
  "POSIX callers in different timezones observe the same live process birth",
  { skip: process.platform === "win32" },
  async () => {
    const moduleUrl = new URL("../src/process-identity.js", import.meta.url).href;
    const script = `import { probeProcessIdentity } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await probeProcessIdentity(${process.pid})));`;
    const identities = [];
    for (const TZ of ["Pacific/Honolulu", "Asia/Tokyo"]) {
      const output = await runTimedExecFile(
        process.execPath,
        ["--input-type=module", "-e", script],
        {
          env: { ...process.env, TZ },
          timeoutMs: 5_000,
        },
      );
      const probe = JSON.parse(output) as { state: string };
      assert.equal(probe.state, "alive");
      identities.push(probe);
    }
    assert.deepEqual(identities[0], identities[1]);
  },
);
